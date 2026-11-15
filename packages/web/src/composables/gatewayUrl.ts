/**
 * The gateway's two addresses: the WebSocket endpoint the dashboard keeps (`gc_ws_url`), and the
 * REST base every `/api/...` request is sent to, which is derived from it.
 *
 * Deliberately free of Vue and of the store, so it can be exercised on its own and used by code
 * that has no store handle (a login form, an extension's own client).
 */

/** The socket URL of a gateway started on its own, before the dashboard was served by it. */
const LEGACY_DIRECT_GATEWAY_WS_URL = "ws://localhost:8765/ws";

/** The page's own origin with `/ws` (ws: or wss: after the page's scheme), or the legacy direct URL outside a page. */
export function defaultGatewayWsUrl(): string {
  if (typeof window === "undefined") {
    return LEGACY_DIRECT_GATEWAY_WS_URL;
  }

  const { protocol, host } = window.location;
  if (!host || protocol === "file:") {
    return LEGACY_DIRECT_GATEWAY_WS_URL;
  }

  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${host}/ws`;
}

/**
 * The socket URL the dashboard connects to for a stored or typed one: empty and the legacy direct
 * URL become the default, http(s) becomes ws(s), a bare origin gets `/ws`, the hash is dropped.
 * Anything that is not an http(s)/ws(s) URL becomes the default; text that is no URL at all is
 * returned trimmed.
 */
export function normalizeGatewayWsUrl(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === LEGACY_DIRECT_GATEWAY_WS_URL) {
    return defaultGatewayWsUrl();
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return defaultGatewayWsUrl();
    }
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/ws";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

/**
 * The REST base of the gateway whose socket URL is `wsUrl`, without a trailing slash, so that
 * `${gatewayRestBaseUrl(wsUrl)}/api/...` is the address of an API route:
 * `wss://host/ws?x=1` -> `https://host`, `ws://host:8765/prefix/ws/` -> `http://host:8765/prefix`.
 *
 * The URL is normalized first, exactly as the store does before it connects, so REST requests go
 * to the gateway the socket talks to. ws: becomes http:, wss: becomes https:; the query string
 * (a socket URL may carry one) and the hash are dropped, then trailing slashes, then one trailing
 * `/ws` segment. Text that is no URL at all gets the same treatment as a string, so a half-typed
 * address in a form never throws.
 */
export function gatewayRestBaseUrl(wsUrl: string | null | undefined): string {
  const normalized = normalizeGatewayWsUrl(wsUrl);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return stripSocketPath(normalized.split(/[?#]/, 1)[0] ?? "").replace(/^ws(s?):/i, "http$1:");
  }
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = stripSocketPath(parsed.pathname);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

/** `/prefix/ws/` -> `/prefix`: trailing slashes, then one trailing `/ws` segment, then trailing slashes again. */
function stripSocketPath(path: string): string {
  return path.replace(/\/+$/, "").replace(/\/ws$/, "").replace(/\/+$/, "");
}
