/**
 * Which WebSocket RPC methods this connection may call.
 *
 * The gateway checks every call against the caller's role (gateway/rpc-policy.ts) and lists, in
 * hello-ok, the methods the connection may call. The page offers only those controls: a viewer
 * reads its chats and sends nothing, and so does an extension role below operator, while a role an
 * extension opened chat to may chat. Guessing from the role's name got both wrong, and locked the
 * composer for a viewer token with auth off, where every method is open. The list is a hint, as the
 * role stood at the handshake; the gateway decides each call, and a gateway that sends no list
 * leaves every control on.
 */

/** The methods hello-ok lists, or null when it lists none (a gateway from before the list). */
export function readAllowedRpcMethods(helloData: unknown): string[] | null {
  const methods = helloData && typeof helloData === "object" ? (helloData as { methods?: unknown }).methods : undefined;
  if (!Array.isArray(methods)) return null;
  return methods.filter((method): method is string => typeof method === "string");
}

/** Whether `method` may be called: always while the gateway has listed nothing. */
export function rpcMethodAllowed(allowed: readonly string[] | null, method: string): boolean {
  return allowed === null || allowed.includes(method);
}
