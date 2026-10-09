/**
 * The account registry: which identity-provider subject owns which account id, under which frozen
 * username, and whether it may sign in.
 *
 * An OIDC user used to be whatever username the ID token claimed, lowercased, and nothing more. The
 * IdP subject was thrown away, so two subjects whose claims lowercased alike ("Alice" and "alice")
 * were one account, and a user who changed the claim became someone else. Each subject now gets an
 * account id at its first sign-in, minted at random, and keeps the username it first signed in
 * with until an admin approves another.
 *
 * The file lives in the deployment's own state directory (`<workspace>/.starlingai/accounts.json`),
 * which no file tool can read and which a stack wipe keeps, so a wipe cannot undo a retire. It is
 * loaded once per workspace path and memory is authoritative after that. Every change is written
 * through a temp file and a rename before memory takes it, so a change that cannot be persisted is
 * not made at all. A file that exists but cannot be read is never written over, and while it cannot
 * be read every lookup fails closed: nobody signs in through it, and the empty-store window stays
 * shut.
 *
 * This module imports no gateway code: the runtime's own guards read it as well.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { PRODUCT } from "../product/index.js";
import { ACCOUNT_ID_RE } from "./accounts.js";

const log = childLogger("runtime:account-registry");

export type AccountRegistryStatus = "active" | "pending" | "retired";

/** One identity-provider subject and the account it owns. */
export interface AccountRegistryEntry {
  /** The account id: the key of the account's own storage. */
  id: string;
  /** The ID token's `iss`, without a trailing slash. */
  issuer: string;
  /** The ID token's `sub`: the IdP's own immutable id for the person. */
  subject: string;
  /** The username frozen at the first sign-in; a token's `sub` must equal it. */
  username: string;
  status: AccountRegistryStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  /** A different username the IdP has since claimed, waiting for an admin's approval. */
  requestedUsername?: string;
  /** Names this account signed in under before an approved rename. They stay held: a grant an
   *  admin wrote for the old name must not pass to whoever claims it next. */
  formerUsernames?: string[];
  retiredAt?: string;
  /** Set by an admin on a retired account: its names may be claimed again. */
  usernameReleased?: boolean;
  /** Data stored under the username before account ids existed, which this account has not taken. */
  legacy?: { segment: string; decision?: "adopted" | "declined"; decidedAt?: string };
}

interface AccountRegistryDocument {
  version: 1;
  accounts: AccountRegistryEntry[];
  /** Subjects seen on bootstrap tokens, for the account migration to tell their data apart. */
  bootstrapSubs: string[];
}

type RegistryState =
  | { path: string; readable: true; doc: AccountRegistryDocument }
  | { path: string; readable: false; reason: string };

let _state: RegistryState | null = null;

/** Where the registry of the deployment at `workspacePath` lives. */
export function accountRegistryPath(workspacePath: string): string {
  return resolve(workspacePath, PRODUCT.stateDirName, "accounts.json");
}

function emptyDocument(): AccountRegistryDocument {
  return { version: 1, accounts: [], bootstrapSubs: [] };
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** Why a parsed entry is not one this module wrote, or undefined when it is. */
function entryProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return "an entry is not an object";
  const entry = value as Record<string, unknown>;
  for (const key of ["id", "issuer", "subject", "username", "firstSeenAt", "lastSeenAt"]) {
    if (typeof entry[key] !== "string" || entry[key] === "") return `an entry has no ${key}`;
  }
  if (!ACCOUNT_ID_RE.test(entry["id"] as string)) return `entry id '${String(entry["id"])}' is malformed`;
  if (!["active", "pending", "retired"].includes(entry["status"] as string)) return `entry ${String(entry["id"])} has an unknown status`;
  if (!isOptionalString(entry["requestedUsername"]) || !isOptionalString(entry["retiredAt"])) return `entry ${String(entry["id"])} is malformed`;
  const former = entry["formerUsernames"];
  if (former !== undefined && (!Array.isArray(former) || former.some((name) => typeof name !== "string"))) return `entry ${String(entry["id"])} is malformed`;
  if (entry["usernameReleased"] !== undefined && typeof entry["usernameReleased"] !== "boolean") return `entry ${String(entry["id"])} is malformed`;
  const legacy = entry["legacy"];
  if (legacy !== undefined && (!legacy || typeof legacy !== "object" || typeof (legacy as Record<string, unknown>)["segment"] !== "string")) {
    return `entry ${String(entry["id"])} is malformed`;
  }
  return undefined;
}

function readDocument(path: string): RegistryState {
  if (!existsSync(path)) return { path, readable: true, doc: emptyDocument() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { path, readable: false, reason: `does not parse (${err instanceof Error ? err.message : String(err)})` };
  }
  const raw = parsed as Partial<AccountRegistryDocument> | null;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.accounts)) return { path, readable: false, reason: "is not an account registry" };
  const bootstrapSubs = raw.bootstrapSubs ?? [];
  if (!Array.isArray(bootstrapSubs) || bootstrapSubs.some((sub) => typeof sub !== "string")) {
    return { path, readable: false, reason: "has a malformed bootstrapSubs list" };
  }
  const seen = new Set<string>();
  for (const entry of raw.accounts) {
    const problem = entryProblem(entry);
    if (problem) return { path, readable: false, reason: problem };
    const key = (entry as AccountRegistryEntry).id.toLowerCase();
    if (seen.has(key)) return { path, readable: false, reason: `holds account id '${(entry as AccountRegistryEntry).id}' twice` };
    seen.add(key);
  }
  return { path, readable: true, doc: { version: 1, accounts: raw.accounts as AccountRegistryEntry[], bootstrapSubs } };
}

/** The registry of the configured workspace, loaded on first use. */
function currentState(): RegistryState {
  const path = accountRegistryPath(getConfig().workspacePath);
  if (_state && _state.path === path) return _state;
  _state = readDocument(path);
  if (_state.readable) {
    log.info({ path, accounts: _state.doc.accounts.length }, "Account registry loaded");
  } else {
    log.error({ path, reason: _state.reason }, "Account registry cannot be read: no identity-provider account can sign in until it is repaired, and it is never written over");
  }
  return _state;
}

/** Loads the registry now (the gateway calls it at boot), so a file that cannot be read is reported
 *  before the first sign-in rather than at it. */
export function loadAccountRegistry(): { readable: boolean; accounts: number } {
  const state = currentState();
  if (!state.readable) return { readable: false, accounts: 0 };
  // One id held by a builtin account and an identity-provider account is one bucket for two people.
  // Neither signs in (gateway/auth.ts); this says so at boot rather than at the first refusal.
  const shared = getConfig().auth.users
    .flatMap((user) => (user.id ? [user.id] : []))
    .filter((id) => state.doc.accounts.some((entry) => entry.id.toLowerCase() === id.toLowerCase()));
  if (shared.length > 0) {
    log.error({ accounts: shared }, "Account ids held by both a builtin account and an identity-provider account; none of them can sign in until an admin resolves it");
  }
  return { readable: true, accounts: state.doc.accounts.length };
}

/** Whether the registry could be read. While it cannot, nothing in it resolves. */
export function accountRegistryReadable(): boolean {
  return currentState().readable;
}

/** Every entry, oldest first. Empty while the registry cannot be read. */
export function accountRegistryEntries(): readonly AccountRegistryEntry[] {
  const state = currentState();
  return state.readable ? state.doc.accounts : [];
}

/** Whether the registry holds any account, or might: one that cannot be read counts as holding
 *  some, so it never opens the empty-store window. */
export function accountRegistryHoldsAccounts(): boolean {
  const state = currentState();
  return !state.readable || state.doc.accounts.length > 0;
}

/** The entry holding this account id (ids compare without case), if any. */
export function accountRegistryEntryById(id: string): AccountRegistryEntry | undefined {
  const key = id.toLowerCase();
  return accountRegistryEntries().find((entry) => entry.id.toLowerCase() === key);
}

/** The entry of this identity-provider subject, if it has signed in before. */
export function accountRegistryEntryBySubject(issuer: string, subject: string): AccountRegistryEntry | undefined {
  return accountRegistryEntries().find((entry) => entry.issuer === issuer && entry.subject === subject);
}

/**
 * The entry that holds this username, if any: as its frozen name, or as a name it held before a
 * rename. Any status counts, a retired account's included, until an admin releases the names. A name
 * an account has only asked for is not held: anyone could otherwise hold any free name by changing
 * their own claim. While the registry cannot be read, every name counts as held.
 */
export function accountRegistryUsernameHolder(username: string): AccountRegistryEntry | "unreadable" | undefined {
  const state = currentState();
  if (!state.readable) return "unreadable";
  const name = username.toLowerCase();
  return state.doc.accounts.find((entry) => !entry.usernameReleased && (
    entry.username === name || (entry.formerUsernames ?? []).includes(name)
  ));
}

/** The subjects seen on bootstrap tokens. */
export function accountRegistryBootstrapSubs(): readonly string[] {
  const state = currentState();
  return state.readable ? state.doc.bootstrapSubs : [];
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;

/** A short synchronous pause: the registry write stays in the caller's tick, so two sign-ins can
 *  never interleave inside one. */
function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Writes the document through a temp file and a rename. On Windows a reader holding the target
 *  open fails the rename for a moment; that is retried a few times. */
function persist(path: string, doc: AccountRegistryDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_ATTEMPTS || !code || !RENAME_RETRY_CODES.has(code)) {
        try { rmSync(tmp, { force: true }); } catch { /* the rename failure is what matters */ }
        throw err;
      }
      pauseSync(20 * attempt);
    }
  }
}

/**
 * Applies a change to a copy of the registry, writes the copy, and only then makes it the registry.
 * Synchronous from start to end. Throws, with nothing changed, when the registry cannot be read or
 * the write fails; `change` returns the value handed back.
 */
export function changeAccountRegistry<T>(change: (doc: AccountRegistryDocument) => T): T {
  const state = currentState();
  if (!state.readable) throw new Error(`the account registry at ${state.path} cannot be read (${state.reason})`);
  const next = structuredClone(state.doc);
  const result = change(next);
  persist(state.path, next);
  _state = { path: state.path, readable: true, doc: next };
  return result;
}

/**
 * Records a subject seen on a bootstrap token, the first time it is seen. Best effort: the list only
 * tells the account migration which buckets belong to bootstrap tokens, so a write that fails is
 * logged and retried the next time the subject is seen.
 */
export function recordAccountRegistryBootstrapSub(sub: string): void {
  const state = currentState();
  if (!state.readable || state.doc.bootstrapSubs.includes(sub)) return;
  try {
    changeAccountRegistry((doc) => {
      if (!doc.bootstrapSubs.includes(sub)) doc.bootstrapSubs.push(sub);
    });
  } catch (err) {
    log.warn({ err, path: state.path }, "Could not record a bootstrap token subject in the account registry");
  }
}

/** Test-only: forget the loaded registry, so the next lookup reads the file again. */
export function resetAccountRegistryForTests(): void {
  _state = null;
}
