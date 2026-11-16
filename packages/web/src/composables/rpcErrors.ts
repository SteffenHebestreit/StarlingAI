import { browserLanguage, chatText } from "./chatText";
import type { TurnLanguage } from "./turnText";

/**
 * What a failed WebSocket RPC call tells the person.
 *
 * The gateway refuses a method the caller's role may not call with an error that starts with
 * "Forbidden:" ("Forbidden: chat.send requires role operator", gateway/rpc-policy.ts). That is an
 * access matter, not a fault: shown as one, and not flashed as an error.
 */

/** The gateway's reason after "Forbidden:", or null when `message` is not a refusal for the role. */
export function forbiddenReason(message: string): string | null {
  const match = /^(?:Error:\s*)?Forbidden:\s*([\s\S]*)$/.exec(message.trim());
  if (!match) return null;
  const reason = match[1]!.trim();
  return reason || "Forbidden";
}

/** The message for an RPC error: a refusal for the role as an access message, anything else as it came. */
export function rpcErrorText(message: string, language: TurnLanguage = browserLanguage()): string {
  const reason = forbiddenReason(message);
  return reason === null ? message : chatText.noAccess(language, reason);
}
