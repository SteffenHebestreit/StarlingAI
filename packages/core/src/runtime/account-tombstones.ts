/**
 * Tombstones: the accounts that were deleted (builtin) or retired (identity provider).
 *
 * A deleted builtin account left nothing behind that named it. Its username was free at once: a
 * channel sender whose raw id was that name was served as a principal whose segment is the bucket
 * the account kept before account ids, and a new identity-provider subject could claim the name and
 * with it every `allowedUsers` grant an admin had written for it. A tombstone records the account,
 * and a builtin one holds its username against both, for good. An admin may still create a builtin
 * account under the name again: that is a deliberate act, and the delete reply listed the grants.
 *
 * An identity-provider account's own registry entry stays, retired, and holds its names until an
 * admin releases them (runtime/account-registry.ts). Its tombstone only records the retirement, so
 * the account migration and a later purge find every ended account in one place; it holds nothing.
 *
 * The file lives beside the registry (`<workspace>/.starlingai/accounts-retired.json`), which no
 * file tool can read and which a stack wipe keeps, so a wipe cannot undo a delete. It is loaded once
 * per workspace path and memory is authoritative after that. A record is written through a temp file
 * and a rename before memory takes it. A file that exists but cannot be read is never written over,
 * and while it cannot be read every name counts as held: the closed direction.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { PRODUCT } from "../product/index.js";
import { ACCOUNT_ID_RE } from "./accounts.js";
import { writeJsonStateFileSync } from "./state-file.js";

const log = childLogger("runtime:account-tombstones");

export type AccountTombstoneKind = "builtin" | "oidc";

/** One ended account. */
export interface AccountTombstone {
  /** The account id; absent for a builtin account deleted before it had one. */
  id?: string;
  /** Its username when it ended, lowercased. */
  username: string;
  kind: AccountTombstoneKind;
  retiredAt: string;
  /** The admin who deleted or retired it. */
  by: string;
}

interface AccountTombstoneDocument {
  version: 1;
  tombstones: AccountTombstone[];
}

type TombstoneState =
  | { path: string; readable: true; doc: AccountTombstoneDocument }
  | { path: string; readable: false; reason: string };

let _state: TombstoneState | null = null;

/** Where the tombstones of the deployment at `workspacePath` live. */
export function accountTombstonesPath(workspacePath: string): string {
  return resolve(workspacePath, PRODUCT.stateDirName, "accounts-retired.json");
}

/** Why a parsed tombstone is not one this module wrote, or undefined when it is. */
function tombstoneProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return "a tombstone is not an object";
  const entry = value as Record<string, unknown>;
  for (const key of ["username", "retiredAt", "by"]) {
    if (typeof entry[key] !== "string" || entry[key] === "") return `a tombstone has no ${key}`;
  }
  if (entry["kind"] !== "builtin" && entry["kind"] !== "oidc") return `the tombstone of '${String(entry["username"])}' has an unknown kind`;
  if (entry["id"] !== undefined && (typeof entry["id"] !== "string" || !ACCOUNT_ID_RE.test(entry["id"]))) {
    return `the tombstone of '${String(entry["username"])}' has a malformed id`;
  }
  return undefined;
}

function readDocument(path: string): TombstoneState {
  if (!existsSync(path)) return { path, readable: true, doc: { version: 1, tombstones: [] } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { path, readable: false, reason: `does not parse (${err instanceof Error ? err.message : String(err)})` };
  }
  const raw = parsed as Partial<AccountTombstoneDocument> | null;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tombstones)) return { path, readable: false, reason: "is not a tombstone list" };
  for (const entry of raw.tombstones) {
    const problem = tombstoneProblem(entry);
    if (problem) return { path, readable: false, reason: problem };
  }
  return { path, readable: true, doc: { version: 1, tombstones: raw.tombstones as AccountTombstone[] } };
}

/** The tombstones of the configured workspace, loaded on first use. */
function currentState(): TombstoneState {
  const path = accountTombstonesPath(getConfig().workspacePath);
  if (_state && _state.path === path) return _state;
  _state = readDocument(path);
  if (!_state.readable) {
    log.error({ path, reason: _state.reason }, "Account tombstones cannot be read: every username counts as held until the file is repaired, and it is never written over");
  }
  return _state;
}

/** Loads the tombstones now (the gateway calls it at boot), so a file that cannot be read is
 *  reported at boot rather than at the first channel message. */
export function loadAccountTombstones(): { readable: boolean; tombstones: number } {
  const state = currentState();
  return state.readable ? { readable: true, tombstones: state.doc.tombstones.length } : { readable: false, tombstones: 0 };
}

/** Every tombstone, oldest first. Empty while the file cannot be read. */
export function accountTombstones(): readonly AccountTombstone[] {
  const state = currentState();
  return state.readable ? state.doc.tombstones : [];
}

/**
 * The tombstone of a deleted builtin account that holds this username, if any. While the file
 * cannot be read every name counts as held. An identity-provider tombstone holds nothing: its
 * registry entry does, until released.
 */
export function builtinTombstoneHolder(username: string): AccountTombstone | "unreadable" | undefined {
  const state = currentState();
  if (!state.readable) return "unreadable";
  const name = username.trim().toLowerCase();
  return state.doc.tombstones.find((entry) => entry.kind === "builtin" && entry.username === name);
}

/**
 * Records an ended account. Throws, with nothing recorded, when the file cannot be read (it is never
 * written over) or the write fails: a caller that ends an account on the strength of the tombstone
 * refuses then.
 */
export function recordAccountTombstone(tombstone: AccountTombstone): void {
  const state = currentState();
  if (!state.readable) throw new Error(`the account tombstones at ${state.path} cannot be read (${state.reason})`);
  const next: AccountTombstoneDocument = {
    version: 1,
    tombstones: [...state.doc.tombstones, { ...tombstone, username: tombstone.username.toLowerCase() }],
  };
  writeJsonStateFileSync(state.path, next);
  _state = { path: state.path, readable: true, doc: next };
}

/** Test-only: forget the loaded tombstones, so the next lookup reads the file again. */
export function resetAccountTombstonesForTests(): void {
  _state = null;
}
