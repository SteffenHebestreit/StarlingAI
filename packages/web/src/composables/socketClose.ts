/**
 * What the dashboard does when the gateway closes its socket, by close code (gateway/index.ts):
 *
 * - `auth-failed`: 4401 (the token was not accepted) or 4429 (too many failed sign-ins). The
 *   sign-in is no good: forget the token and ask for another.
 * - `access-denied`: 4403, a route policy keeps this account's role off the live dashboard. The
 *   sign-in is valid, so the token stays, but reconnecting cannot change the answer.
 * - `reconnect`: anything else; the connection was lost and is retried.
 */
export type SocketCloseOutcome = "auth-failed" | "access-denied" | "reconnect";

export function socketCloseOutcome(code: number): SocketCloseOutcome {
  if (code === 4401 || code === 4429) return "auth-failed";
  if (code === 4403) return "access-denied";
  return "reconnect";
}
