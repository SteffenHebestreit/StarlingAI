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
 * Where they are enforced: every `/api/*` route served by the Hono app, and the
 * surfaces the Node server answers before Hono — `POST /api/chat/stream`,
 * `/mcp`, `/a2a/*`, `/.well-known/agent-card.json` (gateway/raw-policy-gate.ts)
 * and the WebSocket upgrades `/ws` and `/ws/browser-vnc/*` (matched as `GET`).
 * `POST /api/federation/delegate/stream` is never policed: it authenticates a
 * federation peer by HMAC, not a user.
 *
 * Matching rules:
 * - `pattern` is a path matched segment-by-segment against the request path
 * - a `:param` segment matches exactly one path segment
 * - a trailing `/*` matches any remainder (including nothing)
 * - `method` restricts to one HTTP verb; omitted = all verbs
 *
 * A policy takes one of two forms:
 * - `roles` LISTS the role names allowed through. A caller without a token is
 *   refused (401), any other role 403. Rank comparisons are wrong for sibling
 *   roles like a medical fork's `patient` vs `viewer`; listing is also what
 *   reviewers can audit at a glance. The one inheritance is the built-in chain
 *   viewer < operator < admin (policyAdmitsRole below).
 * - `denyRoles` lists the role names refused (403). Everyone else, including a
 *   caller without a session token, passes on, so a deny policy over a prefix
 *   keeps its public routes, its cookie and `?token=` routes and its scoped
 *   capability tokens working.
 *
 * Which policies decide (routePolicyChain), in registration order — an
 * extension's policies register before core's own:
 * - the first matching `roles` policy decides, and nothing after it is consulted;
 * - a matching deny policy in front of it refuses the roles it names, and passes
 *   everyone else on to the next matching policy. A deny policy therefore only
 *   ever subtracts: whoever it does not name gets exactly the answer they would
 *   get without it, including from core's own policies behind it;
 * - `denyRoles: []` refuses nobody and drops every deny policy after it (never a
 *   `roles` policy), which carves an exception out of a broader deny policy.
 *
 * Routes without a matching policy are untouched — they keep whatever auth
 * checks they implement themselves (the upstream default).
 */

interface RoutePolicyBase {
  /** HTTP verb (uppercase); omitted = applies to every verb. */
  method?: string;
  /** Path pattern, e.g. "/api/knowledge/:section" or "/api/admin/*". */
  pattern: string;
}

/** Only the listed roles (and higher built-ins) pass; no caller → 401. */
export interface AllowRolesRoutePolicy extends RoutePolicyBase {
  /** Role names allowed through. Empty array = nobody (effectively disabled). */
  roles: string[];
  denyRoles?: never;
}

/** The listed roles are refused; everyone else, anonymous callers included, is passed on. */
export interface DenyRolesRoutePolicy extends RoutePolicyBase {
  /** Role names refused with 403. Empty array = nobody is refused, and the deny policies after it are dropped. */
  denyRoles: string[];
  roles?: never;
}

export type RoutePolicy = AllowRolesRoutePolicy | DenyRolesRoutePolicy;

/** A registered policy, with the name of whoever registered it (an extension, or core). */
export type MatchedRoutePolicy = RoutePolicy & { source: string };

type RegisteredPolicy = MatchedRoutePolicy & { segments: string[] };

const _policies: RegisteredPolicy[] = [];

/** The built-in roles, lowest first — the chain auth.ts ranks them in (BUILTIN_ROLE_RANKS). */
const BUILTIN_ROLE_CHAIN: readonly string[] = ["viewer", "operator", "admin"];

function isRoleList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** What is wrong with a policy, or null when it is well-formed. */
function routePolicyProblem(policy: unknown): string | null {
  if (typeof policy !== "object" || policy === null) return "a route policy must be an object";
  const entry = policy as Record<string, unknown>;
  if (typeof entry["pattern"] !== "string" || !entry["pattern"].startsWith("/")) {
    return `pattern must start with "/" (got ${JSON.stringify(entry["pattern"]) ?? "nothing"})`;
  }
  if (entry["method"] !== undefined && typeof entry["method"] !== "string") return `"method" must be an HTTP verb`;
  const hasRoles = entry["roles"] !== undefined;
  const hasDenyRoles = entry["denyRoles"] !== undefined;
  if (hasRoles === hasDenyRoles) return `set exactly one of "roles" or "denyRoles"`;
  if (!isRoleList(hasRoles ? entry["roles"] : entry["denyRoles"])) {
    return `"${hasRoles ? "roles" : "denyRoles"}" must be a list of role names`;
  }
  return null;
}

/**
 * Register policies (core and tests; the extension loader goes through registerManifestRoutePolicies).
 * All or none: a malformed policy throws before any registers.
 */
export function registerRoutePolicies(source: string, policies: RoutePolicy[]): void {
  for (const policy of policies) {
    const problem = routePolicyProblem(policy);
    if (!problem) continue;
    const pattern = (policy as { pattern?: unknown } | null)?.pattern;
    throw new Error(`route policy from "${source}"${typeof pattern === "string" ? ` for "${pattern}"` : ""}: ${problem}`);
  }
  for (const policy of policies) {
    _policies.push({
      ...policy,
      ...(policy.method ? { method: policy.method.toUpperCase() } : {}),
      source,
      segments: policy.pattern.split("/").slice(1),
    });
  }
}

/**
 * Registers an extension manifest's policies. They arrive unchecked: a `.js` manifest, or one run
 * through tsx, is not typechecked. A mistake in one never takes the extension down (its roles would
 * go with it, and a role nobody declares signs in as operator), and never widens access:
 * - an entry whose `pattern` is a path but whose form is malformed (both forms, neither, a role list
 *   that is not a list of names, a `method` that is not a string) registers as refusing every caller
 *   on that path (`roles: []`), for its verb when it names a valid one;
 * - an entry without a path pattern, or a `routePolicies` that is not a list, registers nothing:
 *   there is no route to close.
 * Returns one line per problem, for the loader to log.
 */
export function registerManifestRoutePolicies(source: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return [`routePolicies must be a list (got ${value === null ? "null" : typeof value}); none of it is registered`];
  }
  const problems: string[] = [];
  const accepted: RoutePolicy[] = [];
  for (const entry of value as unknown[]) {
    const problem = routePolicyProblem(entry);
    if (!problem) {
      accepted.push(entry as RoutePolicy);
      continue;
    }
    const { pattern, method } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    if (typeof pattern === "string" && pattern.startsWith("/")) {
      accepted.push({ ...(typeof method === "string" && method ? { method } : {}), pattern, roles: [] });
      problems.push(`route policy for "${pattern}": ${problem}; it refuses every caller until it is fixed`);
    } else {
      problems.push(`route policy: ${problem}; not registered`);
    }
  }
  registerRoutePolicies(source, accepted);
  return problems;
}

/**
 * The registered policies that name a role nobody can hold: neither a built-in nor one of
 * `knownRoles` (the extension roles). A resolved caller always holds a known role (auth.ts maps an
 * unknown role claim to operator), so a deny policy refuses nobody by such a name and a roles policy
 * admits nobody by it: a typo, or a role of an extension that did not load.
 */
export function routePolicyUnknownRoles(knownRoles: readonly string[]): Array<{ source: string; method?: string; pattern: string; unknownRoles: string[] }> {
  const known = new Set([...BUILTIN_ROLE_CHAIN, ...knownRoles]);
  const found: Array<{ source: string; method?: string; pattern: string; unknownRoles: string[] }> = [];
  for (const policy of _policies) {
    const unknownRoles = (policy.roles ?? policy.denyRoles ?? []).filter((role) => !known.has(role));
    if (unknownRoles.length === 0) continue;
    found.push({ source: policy.source, ...(policy.method ? { method: policy.method } : {}), pattern: policy.pattern, unknownRoles });
  }
  return found;
}

/** A request path's segments after its leading "/", without its query. */
function requestSegments(path: string | readonly string[]): readonly string[] {
  return typeof path === "string" ? path.split("?")[0]!.split("/").slice(1) : path;
}

function matches(policy: RegisteredPolicy, method: string, pathSegments: readonly string[]): boolean {
  if (policy.method && policy.method !== method.toUpperCase()) return false;
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

/**
 * Whether a policy lets a role through. A listed name admits exactly that role, and among the
 * BUILT-IN roles a listed one also admits every higher built-in: the built-ins are a strict chain
 * everywhere else (userHasRole), and matching them exactly refused an admin the operator-only
 * knowledge-base routes ("Requires role: operator", 2026-10-06). Extension roles never inherit,
 * which keeps sibling roles (a fork's `patient` beside `viewer`) apart as the listing intends.
 *
 * A `denyRoles` policy lets through every role it does not name, exactly: denying `viewer` does
 * not deny anyone else, and denying `admin` does not deny a lower role.
 */
export function policyAdmitsRole(
  policy: { roles?: readonly string[]; denyRoles?: readonly string[] },
  role: string,
): boolean {
  if (!policy.roles) return policy.denyRoles ? !policy.denyRoles.includes(role) : false;
  if (policy.roles.includes(role)) return true;
  const rank = BUILTIN_ROLE_CHAIN.indexOf(role);
  if (rank < 0) return false;
  return policy.roles.some((listed) => {
    const listedRank = BUILTIN_ROLE_CHAIN.indexOf(listed);
    return listedRank >= 0 && listedRank <= rank;
  });
}

/**
 * What one policy makes of a caller:
 * - `allow`: a `roles` policy admits the caller; the route runs.
 * - `pass`: a `denyRoles` policy does not refuse the caller (or there is none): the next matching
 *   policy decides, and with none the route runs and applies its own auth, so a public route stays
 *   public and a route that takes another kind of credential still sees it.
 * - `unauthorized`: a `roles` policy and no resolvable caller (401).
 * - `forbidden`: the caller's role is not admitted (403).
 */
export type RoutePolicyVerdict = "allow" | "pass" | "unauthorized" | "forbidden";

export function evaluateRoutePolicy(policy: RoutePolicy, user: { role: string } | null): RoutePolicyVerdict {
  if (policy.denyRoles) {
    if (!user) return "pass";
    return policy.denyRoles.includes(user.role) ? "forbidden" : "pass";
  }
  if (!user) return "unauthorized";
  return policyAdmitsRole(policy, user.role) ? "allow" : "forbidden";
}

/** The reason a gate gives with its 403. */
export function routePolicyForbiddenMessage(policy: RoutePolicy, role: string): string {
  return policy.roles ? `Requires role: ${policy.roles.join(" | ")}` : `Not permitted for role ${role}`;
}

/**
 * The first matching policy for a request, or null when the route is unpoliced. The gates decide by
 * routePolicyChain, where a deny policy that does not name the caller passes it on to the next.
 */
export function findRoutePolicy(method: string, path: string): MatchedRoutePolicy | null {
  const segments = requestSegments(path);
  for (const policy of _policies) {
    if (matches(policy, method, segments)) return policy;
  }
  return null;
}

/**
 * The policies that decide a request, in the order they apply (see the module comment): the matching
 * deny policies up to the first matching `roles` policy, which ends the chain; an empty deny list
 * drops the deny policies after it. Empty when no policy governs the request. `path` is a request
 * path, or its segments already decoded the way the route's handler reads them.
 */
export function routePolicyChain(method: string, path: string | readonly string[]): MatchedRoutePolicy[] {
  const segments = requestSegments(path);
  const chain: MatchedRoutePolicy[] = [];
  let excepted = false;
  for (const policy of _policies) {
    if (!matches(policy, method, segments)) continue;
    if (policy.roles) {
      chain.push(policy);
      break;
    }
    if (excepted) continue;
    if (policy.denyRoles.length === 0) {
      excepted = true;
      continue;
    }
    chain.push(policy);
  }
  return chain;
}

/** A chain's answer for a request, with the policy that gave it and the caller it refused or admitted. */
export interface RoutePolicyDecision<U extends { role: string }> {
  verdict: RoutePolicyVerdict;
  /** The policy that decided; null when every policy in the chain passed the request on. */
  policy: MatchedRoutePolicy | null;
  caller: U | null;
}

/**
 * Decides a request by its chain. `callersFor` gives the callers the request presents to a policy
 * (several tokens can each resolve to one): without a caller a policy gives its anonymous verdict;
 * otherwise the request is refused when any caller is, and the first caller stands for the rest.
 * The first policy whose verdict is not `pass` decides.
 */
export function decideRoutePolicyChain<U extends { role: string }>(
  chain: readonly MatchedRoutePolicy[],
  callersFor: (policy: MatchedRoutePolicy) => readonly U[],
): RoutePolicyDecision<U> {
  for (const policy of chain) {
    const callers = callersFor(policy);
    let verdict: RoutePolicyVerdict;
    let caller: U | null = callers[0] ?? null;
    if (callers.length === 0) {
      verdict = evaluateRoutePolicy(policy, null);
    } else {
      const refused = callers.find((candidate) => evaluateRoutePolicy(policy, candidate) === "forbidden");
      if (refused) caller = refused;
      verdict = refused ? "forbidden" : evaluateRoutePolicy(policy, caller);
    }
    if (verdict !== "pass") return { verdict, policy, caller };
  }
  return { verdict: "pass", policy: null, caller: null };
}

/** Test hook. */
export function _resetRoutePoliciesForTests(): void {
  _policies.length = 0;
}
