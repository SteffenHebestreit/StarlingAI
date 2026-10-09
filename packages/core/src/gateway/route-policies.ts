/**
 * Route policies — declarative RBAC for gateway API routes.
 *
 * Core extensions (and core itself) register policies mapping route patterns
 * to the role names allowed to call them. A single gate middleware in
 * createGateway() enforces them BEFORE route handlers run, so forks gain
 * fine-grained per-route access control without wrapping or editing core
 * route registrations (docs/fork-boilerplate-plan.md WS7 — the MFA fork
 * previously edited ~30 core routes to add role checks).
 *
 * Matching rules (first registered match wins):
 * - `pattern` is a path matched segment-by-segment against the request path
 * - a `:param` segment matches exactly one path segment
 * - a trailing `/*` matches any remainder (including nothing)
 * - `method` restricts to one HTTP verb; omitted = all verbs
 *
 * Policies LIST allowed role names explicitly: rank comparisons are wrong for
 * sibling roles like a medical fork's `patient` vs `viewer`. Listing is also
 * what reviewers can audit at a glance. The one inheritance is the built-in
 * chain viewer < operator < admin (policyAdmitsRole below).
 *
 * Routes without a matching policy are untouched — they keep whatever auth
 * checks they implement themselves (the upstream default).
 */

export interface RoutePolicy {
  /** HTTP verb (uppercase); omitted = applies to every verb. */
  method?: string;
  /** Path pattern, e.g. "/api/knowledge/:section" or "/api/admin/*". */
  pattern: string;
  /** Role names allowed through. Empty array = nobody (effectively disabled). */
  roles: string[];
}

interface RegisteredPolicy extends RoutePolicy {
  source: string;
  segments: string[];
}

const _policies: RegisteredPolicy[] = [];

/** Register policies (loader calls this per extension; core may add its own). */
export function registerRoutePolicies(source: string, policies: RoutePolicy[]): void {
  for (const policy of policies) {
    if (!policy.pattern.startsWith("/")) {
      throw new Error(`route policy from "${source}": pattern must start with "/" (got "${policy.pattern}")`);
    }
    _policies.push({
      ...policy,
      ...(policy.method ? { method: policy.method.toUpperCase() } : {}),
      source,
      segments: policy.pattern.split("/").slice(1),
    });
  }
}

function matches(policy: RegisteredPolicy, method: string, path: string): boolean {
  if (policy.method && policy.method !== method.toUpperCase()) return false;
  const pathSegments = path.split("?")[0]!.split("/").slice(1);
  const patternSegments = policy.segments;
  for (let i = 0; i < patternSegments.length; i++) {
    const pattern = patternSegments[i]!;
    if (pattern === "*" && i === patternSegments.length - 1) return true;
    const actual = pathSegments[i];
    if (actual === undefined) return false;
    if (pattern.startsWith(":")) continue;
    if (pattern !== actual) return false;
  }
  return pathSegments.length === patternSegments.length;
}

/** The built-in roles, lowest first — the chain auth.ts ranks them in (BUILTIN_ROLE_RANKS). */
const BUILTIN_ROLE_CHAIN: readonly string[] = ["viewer", "operator", "admin"];

/**
 * Whether a policy lets a role through. A listed name admits exactly that role, and among the
 * BUILT-IN roles a listed one also admits every higher built-in: the built-ins are a strict chain
 * everywhere else (userHasRole), and matching them exactly refused an admin the operator-only
 * knowledge-base routes ("Requires role: operator", 2026-10-06). Extension roles never inherit,
 * which keeps sibling roles (a fork's `patient` beside `viewer`) apart as the listing intends.
 */
export function policyAdmitsRole(policy: Pick<RoutePolicy, "roles">, role: string): boolean {
  if (policy.roles.includes(role)) return true;
  const rank = BUILTIN_ROLE_CHAIN.indexOf(role);
  if (rank < 0) return false;
  return policy.roles.some((listed) => {
    const listedRank = BUILTIN_ROLE_CHAIN.indexOf(listed);
    return listedRank >= 0 && listedRank <= rank;
  });
}

/** First matching policy for a request, or null when the route is unpoliced. */
export function findRoutePolicy(method: string, path: string): (RoutePolicy & { source: string }) | null {
  for (const policy of _policies) {
    if (matches(policy, method, path)) return policy;
  }
  return null;
}

/** Test hook. */
export function _resetRoutePoliciesForTests(): void {
  _policies.length = 0;
}
