/**
 * Route policies (gateway/route-policies.ts) for the surfaces the Node server answers itself.
 *
 * The policy gate in createGateway() is Hono middleware on `/api/*`. Several surfaces never reach
 * Hono: the Node `createServer` handler answers `/mcp`, the A2A routes, the agent card and the
 * AG-UI stream directly, and the `upgrade` listener hands `/ws` and `/ws/browser-vnc/*` to their
 * WebSocket servers. A policy an extension declared for one of them was never consulted, so a fork
 * could not close them to a role. These helpers apply the same policies there:
 *
 * - `gateRawHttp` runs in createServer before the raw handlers (after the federation stream, which
 *   authenticates a peer by HMAC, not a user) and answers 401/403 for a refused caller.
 * - `upgradePolicyRefusal` runs in the upgrade listener; the caller closes the socket with the
 *   status it returns (a WebSocket close code on `/ws`, an HTTP status on the VNC proxy).
 *
 * With no matching policy both do nothing and the request goes on exactly as before.
 *
 * A request can present more than one session token (an Authorization header and a `?token=`, a
 * cookie) and the handlers differ in which one they act on: the dashboard socket reads `?token=`
 * first, the AG-UI stream the header first. The gate therefore checks every token presented
 * (decideRoutePolicyChainForTokens), so a denied role cannot pass the gate with one credential and
 * reach the handler with another.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { logAudit } from "../audit/logger.js";
import { A2A_ERROR } from "../a2a/protocol.js";
import { authenticatedUserFromToken, extractBearerToken, type AuthenticatedUser } from "./auth.js";
import {
  decideRoutePolicyChain,
  routePolicyChain,
  routePolicyForbiddenMessage,
  type MatchedRoutePolicy,
  type RoutePolicyDecision,
} from "./route-policies.js";

/**
 * Cookies that carry a session token: the served-site preview and the live-app proxy mirror a
 * `?token=` into them for a page's own sub-resource requests (gateway/workspace-routes.ts).
 */
const SESSION_TOKEN_COOKIES: readonly string[] = ["sai_site_token", "sai_app_token"];

/** The session tokens a request presents, in no particular order, without duplicates or blanks. */
export function presentedTokens(sources: {
  authorization?: string | string[] | null;
  query?: string | null;
  cookie?: string | string[] | null;
}): string[] {
  const tokens = new Set<string>();
  const add = (value: string | null | undefined) => {
    const token = value?.trim();
    if (token) tokens.add(token);
  };
  const authorization = Array.isArray(sources.authorization) ? sources.authorization[0] : sources.authorization;
  add(extractBearerToken(authorization));
  add(sources.query);
  const cookie = Array.isArray(sources.cookie) ? sources.cookie.join("; ") : sources.cookie;
  if (cookie) {
    for (const part of cookie.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      if (!SESSION_TOKEN_COOKIES.includes(part.slice(0, separator).trim())) continue;
      try {
        add(decodeURIComponent(part.slice(separator + 1).trim()));
      } catch {
        // A malformed escape is no token.
      }
    }
  }
  return [...tokens];
}

/**
 * Decides a request by its policy chain (route-policies.ts), resolving each token a policy is shown
 * once, as the handlers resolve it (authenticatedUserFromToken: the stores under multi-user auth,
 * the token's own claims without). A token that resolves to nobody counts as no caller.
 */
export async function decideRoutePolicyChainForTokens(
  chain: readonly MatchedRoutePolicy[],
  tokensFor: (policy: MatchedRoutePolicy) => readonly string[],
): Promise<RoutePolicyDecision<AuthenticatedUser>> {
  const resolved = new Map<string, AuthenticatedUser | null>();
  for (const policy of chain) {
    for (const token of tokensFor(policy)) {
      if (!resolved.has(token)) resolved.set(token, await authenticatedUserFromToken(token));
    }
  }
  return decideRoutePolicyChain(chain, (policy) =>
    tokensFor(policy).map((token) => resolved.get(token)).filter((user): user is AuthenticatedUser => Boolean(user)));
}

/**
 * The path's segments as the raw handlers read them. The legacy A2A route percent-decodes the agent
 * name, so a policy for `/a2a/agents/<name>` has to see the decoded name: matched on the path as
 * sent, `/a2a/agents/%78` ran agent "x" past a policy for it. A decoded "/" stays inside its
 * segment, and a segment whose escapes do not decode stays as sent (its handler cannot decode it
 * either).
 */
export function policyPathSegments(pathname: string): string[] {
  return pathname.split("/").slice(1).map((segment) => {
    if (!segment.includes("%")) return segment;
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

/**
 * Whether createServer answers this request itself, before Hono (gateway/index.ts). Every other
 * request reaches Hono, whose own gate covers `/api/*`, so gating it here too would gate it twice.
 */
export function isRawSurface(method: string, pathname: string): boolean {
  if (pathname === "/api/chat/stream") return method.toUpperCase() === "POST";
  return pathname === "/mcp"
    || pathname.startsWith("/mcp/")
    || pathname.startsWith("/a2a/")
    || pathname === "/.well-known/agent-card.json";
}

export interface PolicyRefusal {
  status: 401 | 403;
  message: string;
}

async function policyRefusal(
  method: string,
  url: URL,
  req: IncomingMessage,
  surface: "raw" | "ws",
): Promise<PolicyRefusal | null> {
  const chain = routePolicyChain(method, policyPathSegments(url.pathname));
  if (chain.length === 0) return null;
  const tokens = presentedTokens({ authorization: req.headers["authorization"], query: url.searchParams.get("token") });
  const { verdict, policy, caller } = await decideRoutePolicyChainForTokens(chain, () => tokens);
  if (verdict === "unauthorized") return { status: 401, message: "Unauthorized" };
  if (verdict === "forbidden" && policy && caller) {
    logAudit("rbac_denied", { surface, method, path: url.pathname, role: caller.role }, { userId: caller.username, severity: "warn" });
    return { status: 403, message: routePolicyForbiddenMessage(policy, caller.role) };
  }
  return null;
}

/**
 * Applies the route policies to a request createServer answers itself. Returns true when it
 * refused the request (the response is written), false when the request goes on.
 */
export async function gateRawHttp(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  if (!isRawSurface(method, pathname)) return false;
  const refusal = await policyRefusal(method, new URL(req.url ?? "/", "http://localhost"), req, "raw");
  if (!refusal) return false;
  let body: unknown = { error: refusal.message };
  if (pathname.startsWith("/a2a/")) {
    // The JSON-RPC shape the A2A handlers answer in, with the unauthorized code each one uses.
    const unauthorizedCode = pathname === "/a2a/v1" ? A2A_ERROR.UNAUTHORIZED.code : -32001;
    body = {
      jsonrpc: "2.0",
      error: { code: refusal.status === 401 ? unauthorizedCode : -32003, message: refusal.message },
      id: null,
    };
  }
  res.writeHead(refusal.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
  return true;
}

/** The route policy's refusal of a WebSocket upgrade (matched as GET), or null to let it through. */
export async function upgradePolicyRefusal(req: IncomingMessage): Promise<PolicyRefusal | null> {
  return policyRefusal("GET", new URL(req.url ?? "/", "http://localhost"), req, "ws");
}
