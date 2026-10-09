/**
 * Account ids: the immutable key that per-account storage hangs off.
 *
 * The per-user bucket used to be derived from the username (safeUserSegment of the JWT `sub`), so
 * a deleted account re-created under the same name inherited everything the old one left: its
 * workspace, memory, ledger stamps and sessions. An account id is minted once, at random, and
 * never derived from the name, so a new account under an old name gets a new id and an empty
 * bucket. Its shape is that of a user segment (`<prefix>-<16 hex>`), so the id IS the segment: one
 * key for paths, record stamps, graph tenants and ownership.
 *
 * Everything that is not an account (a bootstrap token, a channel sender, an A2A peer, a scene or
 * job run) is a principal, and keeps the segment its raw name always had.
 *
 * This module imports nothing from the config or the request context, so the config schema can
 * validate ids with it without an import cycle.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { PRODUCT } from "../product/index.js";

/** An account id, and every user segment: a readable prefix, a dash, 16 hex digits. */
export const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]+-[0-9a-f]{16}$/;

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

/** What a non-account identity can be. */
export type PrincipalKind = "bootstrap" | "channel" | "peer" | "synthetic";

/**
 * Who a request, a session or a record belongs to, as one value. `userId` is the display name: the
 * frozen username of an account, the raw string of a principal. A new identity sets exactly one of
 * `account` and `principal`; a record with neither predates account ids.
 */
export interface Identity {
  userId?: string;
  account?: string;
  principal?: PrincipalKind;
}

/** The readable prefix of a builtin account id: the username, lowercased, with anything outside
 *  `[a-z0-9_-]` replaced. Only for legibility; the random part makes the id. */
export function accountIdSlug(username: string): string {
  return username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 48).replace(/^-+/, "") || "u";
}

/** A fresh builtin account id. Random, never derived from the name: an id that a name alone
 *  produced would be produced again for the next person given that name. */
export function newBuiltinAccountId(username: string): string {
  return `${accountIdSlug(username)}-${randomBytes(8).toString("hex")}`;
}

/** A fresh account id for an identity-provider subject. */
export function newOidcAccountId(): string {
  return `oidc-${randomBytes(8).toString("hex")}`;
}

/** The account id of an extension auth provider's user: its token `sub` is already the provider's
 *  immutable id, so the segment it always had stays, and nothing moves. */
export function extensionAccountId(sub: string): string {
  return safeUserSegment(sub);
}

/** The storage segment of a principal: the one its raw name always had. */
export function principalSegment(raw: string): string {
  return safeUserSegment(raw);
}

/** The `sub` a bootstrap token carries unless told otherwise (`sai token`, the setup wizard). */
export const DEFAULT_BOOTSTRAP_SUB = "admin";

/** Ids compare without case: on a case-insensitive filesystem `Alice-…` and `alice-…` are one
 *  directory, so they are one bucket. */
export function sameAccountId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Why an id may not be an account's, or undefined when it may. The default bootstrap token's
 * bucket is `principalSegment("admin")`; an account holding that id would share it.
 */
export function reservedAccountIdProblem(id: string): string | undefined {
  return sameAccountId(id, principalSegment(DEFAULT_BOOTSTRAP_SUB))
    ? `account id '${id}' is the bootstrap token's storage segment`
    : undefined;
}

/**
 * A fresh builtin account id that no listed id holds, nor the bootstrap segment. A clash takes
 * 2^64 tries on average; a few retries make it impossible in practice, and the config load refuses
 * a duplicate whatever happens here.
 */
export function mintBuiltinAccountId(username: string, taken: Iterable<string>): string {
  const held = new Set([...taken].map((id) => id.toLowerCase()));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newBuiltinAccountId(username);
    if (!held.has(id.toLowerCase()) && !reservedAccountIdProblem(id)) return id;
  }
  throw new Error("could not mint an account id that no other account holds");
}

/** One line of the account ledger. */
export interface AccountLedgerEntry {
  event: "created";
  id: string;
  username: string;
  at: string;
}

/**
 * The account ledger: which ids were minted for new accounts, and later which legacy data an
 * account adopted. It lives in the deployment's own state directory, which no file tool can read
 * and which a stack wipe keeps. Never trimmed: an entry is what tells an account created after the
 * upgrade from one that predates it.
 */
export function accountLedgerPath(workspacePath: string): string {
  return resolve(workspacePath, PRODUCT.stateDirName, "account-migrations.ndjson");
}

/** Appends one entry. Throws when it cannot be written, so a caller can refuse what it records. */
export function appendAccountLedgerEntry(path: string, entry: AccountLedgerEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}
