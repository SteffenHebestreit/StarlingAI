/**
 * The open dashboard sockets of each account.
 *
 * A WebSocket checks its caller again before every message it handles and every event it pushes
 * (gateway/rpc.ts), so a deleted or retired account cannot act through a socket it opened earlier.
 * A socket that only listens would still hold on until its next push. Deleting, retiring or
 * renaming an account therefore closes its sockets here at once.
 */

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
