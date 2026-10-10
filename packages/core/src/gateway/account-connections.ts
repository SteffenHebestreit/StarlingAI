/**
 * The open dashboard sockets of each account.
 *
 * A WebSocket checks its caller again before every message it handles and every event it pushes
 * (gateway/rpc.ts), so a deleted or retired account cannot act through a socket it opened earlier.
 * A socket that only listens would still hold on until its next push. Deleting, retiring or
 * renaming an account therefore closes its sockets here at once.
 */
import { childLogger } from "../logger.js";

const log = childLogger("gateway:account-connections");

/** What this registry needs from a connection. */
export interface AccountConnection {
  /** Close the socket because its account no longer signs in. */
  revoke(reason: string): void;
}

const _byAccount = new Map<string, Set<AccountConnection>>();

/** Track a connection of `account`; the returned function stops tracking it. */
export function trackAccountConnection(account: string, connection: AccountConnection): () => void {
  const key = account.toLowerCase();
  let set = _byAccount.get(key);
  if (!set) {
    set = new Set();
    _byAccount.set(key, set);
  }
  set.add(connection);
  return () => {
    const current = _byAccount.get(key);
    if (!current) return;
    current.delete(connection);
    if (current.size === 0) _byAccount.delete(key);
  };
}

/** Close every open socket of `account`. Returns how many there were. */
export function closeAccountConnections(account: string, reason: string): number {
  const set = _byAccount.get(account.toLowerCase());
  if (!set) return 0;
  const connections = [...set];
  for (const connection of connections) connection.revoke(reason);
  return connections.length;
}

/** How many sockets `account` has open. */
export function accountConnectionCount(account: string): number {
  return _byAccount.get(account.toLowerCase())?.size ?? 0;
}

// ── Other bindings an account holds in memory ─────────────────────────────────
// An MCP HTTP session and an A2A task are bound to the account that opened them. A deleted or
// retired account cannot reach them again (each request resolves its caller against the stores),
// but they stay in memory: an MCP session with its server, an A2A task with its output. The module
// that holds each kind registers its teardown here when it loads; a module that never loaded holds
// none, so nothing has to import it to end an account.

/** Ends every binding of one kind that `account` holds; returns how many it ended. */
export type AccountBindingTeardown = (account: string, reason: string) => number | Promise<number>;

const _bindingTeardowns = new Map<string, AccountBindingTeardown>();

/** Registers the teardown of one kind of binding (one per kind; a later one replaces it). */
export function registerAccountBindingTeardown(kind: string, teardown: AccountBindingTeardown): void {
  _bindingTeardowns.set(kind, teardown);
}

/**
 * Ends every binding `account` holds, of every registered kind. A kind whose teardown fails is
 * named in `failed`, and the others still run.
 */
export async function endAccountBindings(account: string, reason: string): Promise<{ ended: Record<string, number>; failed: string[] }> {
  const ended: Record<string, number> = {};
  const failed: string[] = [];
  for (const [kind, teardown] of _bindingTeardowns) {
    try {
      ended[kind] = await teardown(account, reason);
    } catch (err) {
      log.error({ err, account, kind }, "Could not end an ended account's bindings of one kind");
      failed.push(kind);
    }
  }
  return { ended, failed };
}
