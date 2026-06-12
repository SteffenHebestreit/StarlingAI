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
 * Policies LIST allowed role names explicitly (no rank inheritance): rank
 * comparisons are wrong for sibling roles like a medical fork's `patient`
 * vs `viewer`. Listing is also what reviewers can audit at a glance.
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

/** First matching policy for a request, or null when the route is unpoliced. */
export function findRoutePolicy(method: string, path: string): (RoutePolicy & { source: string }) | null {
  for (const policy of _policies) {
    if (matches(policy, method, path)) return policy;
  }
  return null;
}

/** All registered policies (diagnostics). */
export function listRoutePolicies(): ReadonlyArray<RoutePolicy & { source: string }> {
  return _policies;
}

/** Test hook. */
export function _resetRoutePoliciesForTests(): void {
  _policies.length = 0;
}
