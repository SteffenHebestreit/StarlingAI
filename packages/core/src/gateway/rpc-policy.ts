/**
 * Who may call which method of the WebSocket RPC (/ws, gateway/rpc.ts).
 *
 * The socket handshake admits any caller whose token resolves, and the methods used to read the
 * caller's role in one place only: whether it may reach another account's session. So a viewer got
 * over the socket everything an operator gets (a new session, a turn, its approvals), while the
 * REST equivalents refuse it with 403 (the mutation gate in gateway/index.ts). Every method now has
 * a minimum built-in role, checked before the method runs.
 *
 * The default is by rank, like userHasRole and the mutation gate: an extension role passes when its
 * rank reaches the minimum's (a rank-50 role passes "operator", a rank-10 one does not).
 *
 * Extensions may change the default per method (`rpcPolicies` on CoreExtension), in load order,
 * first match wins:
 * - `{ method, roles }` replaces the default for the methods it matches: exactly the listed roles
 *   pass, with the built-in chain viewer < operator < admin (policyAdmitsRole). This is how a fork
 *   opens a method to a sibling role of its own, e.g. a portal role below operator. A turn's
 *   approvals and questions go back to the socket that started it, so a role given chat.send needs
 *   chat.cancel, approval.respond, input.respond and userInput.* with it (docs/forking.md).
 * - `{ method, denyRoles }` refuses the listed roles and leaves everyone else to the default.
 * `method` is an exact method name, `prefix.*` (every method under `prefix.`) or `*`. A malformed
 * entry in a manifest never fails the extension's load; it registers as one that refuses every
 * caller (registerManifestRpcPolicies).
 *
 * With auth off there is one operator and no roles to compare: every method is allowed, as before.
 */
import type { RpcMethod } from "./rpc.js";
import { roleRank } from "./auth.js";
import { policyAdmitsRole } from "./route-policies.js";

/** The built-in role a method requires by default. */
export type RpcMinRole = "viewer" | "operator" | "admin";

/**
 * The default minimum role of every RPC method. Typed over RpcMethod, so a method added to the
 * protocol does not compile until it is classified here.
 */
export const RPC_METHOD_MIN_ROLE: Readonly<Record<RpcMethod, RpcMinRole>> = {
  // Reading: the caller's own sessions, the catalogue, its own event streams.
  "gateway.status": "viewer",
  "session.list": "viewer",
  "session.get": "viewer",
  "scenes.list": "viewer",
  "jobs.list": "viewer",
  "audit.subscribe": "viewer",
  "audit.unsubscribe": "viewer",
  "notifications.subscribe": "viewer",
  "notifications.unsubscribe": "viewer",
  "computer.list_sessions": "viewer",
  // Changing something: a session, a turn, an answer a turn waits for, a computer-use session.
  "session.create": "operator",
  "session.end": "operator",
  "session.archive": "operator",
  "session.delete": "operator",
  "session.reset": "operator",
  "session.rewind": "operator",
  "session.updateSettings": "operator",
  "chat.send": "operator",
  "chat.cancel": "operator",
  "approval.respond": "operator",
  "input.respond": "operator",
  "userInput.respond": "operator",
  "userInput.hold": "operator",
  "userInput.preview": "operator",
  "computer.emergency_stop": "operator",
  "computer.heartbeat": "operator",
  "computer.request_screenshot": "operator",
};

/** An extension's rule for some RPC methods; see the module comment. */
export type RpcPolicyDef =
  | { method: string; roles: string[] }
  | { method: string; denyRoles: string[] };

interface RegisteredRpcPolicy {
  source: string;
  method: string;
  roles?: string[];
  denyRoles?: string[];
}

const _policies: RegisteredRpcPolicy[] = [];

const METHOD_PATTERN = /^(\*|[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*(\.\*)?)$/;

function isRoleList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((role) => typeof role === "string" && role.length > 0);
}

/** Whether `method` is something a policy may name: an exact method name, `prefix.*` or `*`. */
function isMethodPattern(method: unknown): method is string {
  return typeof method === "string" && METHOD_PATTERN.test(method);
}

/** What is wrong with `policy`, or null when it is a well-formed RpcPolicyDef. */
function rpcPolicyProblem(policy: unknown): string | null {
  const def = (typeof policy === "object" && policy !== null ? policy : {}) as Record<string, unknown>;
  const method = def["method"];
  if (!isMethodPattern(method)) return `method must be a method name, "prefix.*" or "*" (got ${JSON.stringify(method)})`;
  const hasRoles = "roles" in def;
  const hasDeny = "denyRoles" in def;
  if (hasRoles === hasDeny) return "give exactly one of roles or denyRoles";
  if (!isRoleList(hasRoles ? def["roles"] : def["denyRoles"])) return `${hasRoles ? "roles" : "denyRoles"} must be a list of role names`;
  return null;
}

/** Throws when `policy` is not a well-formed RpcPolicyDef. `source` names its extension in the error. */
export function validateRpcPolicy(source: string, policy: unknown): asserts policy is RpcPolicyDef {
  const problem = rpcPolicyProblem(policy);
  if (!problem) return;
  const method = (policy as { method?: unknown } | null | undefined)?.method;
  throw new Error(`rpc policy from "${source}"${isMethodPattern(method) ? ` for "${method}"` : ""}: ${problem}`);
}

/**
 * Register RPC policies (tests and core; the extension loader goes through
 * registerManifestRpcPolicies). All of them are checked before any is registered, so a malformed
 * list throws and registers nothing.
 */
export function registerRpcPolicies(source: string, policies: readonly RpcPolicyDef[]): void {
  for (const policy of policies) validateRpcPolicy(source, policy);
  for (const policy of policies) {
    _policies.push("roles" in policy
      ? { source, method: policy.method, roles: [...policy.roles] }
      : { source, method: policy.method, denyRoles: [...policy.denyRoles] });
  }
}

/**
 * Registers an extension manifest's RPC policies. They arrive unchecked: a `.js` manifest, or one
 * run through tsx, is not typechecked. A mistake in one never takes the extension down (its roles
 * would go with it, and a role nobody declares signs in as operator), and never widens access. The
 * first matching policy decides, so a malformed entry registers in its place as one that refuses
 * every caller (`roles: []`):
 * - for its `method`, when that is a method name, `prefix.*` or `*`;
 * - for every method (`*`) when it is not, when the entry is no object, and in place of an
 *   `rpcPolicies` that is not a list: there is no telling which methods it meant.
 * Returns one line per problem, for the loader to log.
 */
export function registerManifestRpcPolicies(source: string, value: unknown): string[] {
  if (value === undefined) return [];
  const refuseEveryone = (method: string): RpcPolicyDef => ({ method, roles: [] });
  if (!Array.isArray(value)) {
    registerRpcPolicies(source, [refuseEveryone("*")]);
    return [`rpcPolicies must be a list (got ${value === null ? "null" : typeof value}); it refuses every method to every caller until it is fixed`];
  }
  const problems: string[] = [];
  const accepted: RpcPolicyDef[] = [];
  for (const entry of value as unknown[]) {
    const problem = rpcPolicyProblem(entry);
    if (!problem) {
      accepted.push(entry as RpcPolicyDef);
      continue;
    }
    const method = (typeof entry === "object" && entry !== null ? entry : {}) as { method?: unknown };
    if (isMethodPattern(method.method)) {
      accepted.push(refuseEveryone(method.method));
      problems.push(`rpc policy for "${method.method}": ${problem}; it refuses the method to every caller until it is fixed`);
    } else {
      accepted.push(refuseEveryone("*"));
      problems.push(`rpc policy: ${problem}; it refuses every method to every caller until it is fixed`);
    }
  }
  registerRpcPolicies(source, accepted);
  return problems;
}

function policyMatches(pattern: string, method: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return method.startsWith(pattern.slice(0, -1));
  return pattern === method;
}

/** Whether `method` is one of the protocol's methods (an own key of the table, never "toString"). */
export function isRpcMethod(method: unknown): method is RpcMethod {
  return typeof method === "string" && Object.hasOwn(RPC_METHOD_MIN_ROLE, method);
}

export type RpcAuthorization =
  | { allowed: true }
  | { allowed: false; reason: "unknown_method"; error: string }
  | { allowed: false; reason: "forbidden"; error: string; required: string; policy?: string };

/**
 * Whether a caller holding `role` may call `method`. `authEnabled` is `auth.enabled`: without it
 * every method is allowed, whatever the role (there may be none).
 */
export function authorizeRpc(method: unknown, role: string | undefined, authEnabled: boolean): RpcAuthorization {
  if (!authEnabled) return { allowed: true };
  if (!isRpcMethod(method)) return { allowed: false, reason: "unknown_method", error: `Unknown method: ${String(method)}` };
  const callerRole = role ?? "";
  for (const policy of _policies) {
    if (!policyMatches(policy.method, method)) continue;
    if (policy.roles) {
      if (callerRole && policyAdmitsRole({ roles: policy.roles }, callerRole)) return { allowed: true };
      const required = policy.roles.length > 0 ? policy.roles.join(" or ") : "(none)";
      return { allowed: false, reason: "forbidden", error: `Forbidden: ${method} requires role ${required}`, required, policy: policy.source };
    }
    if (policy.denyRoles?.includes(callerRole)) {
      return { allowed: false, reason: "forbidden", error: `Forbidden: ${method} is not available to role ${callerRole}`, required: "(denied)", policy: policy.source };
    }
    // A deny rule that does not name the caller leaves the method to the default.
    break;
  }
  const min = RPC_METHOD_MIN_ROLE[method];
  if (callerRole && roleRank(callerRole) >= roleRank(min)) return { allowed: true };
  return { allowed: false, reason: "forbidden", error: `Forbidden: ${method} requires role ${min}`, required: min };
}

/**
 * The methods a caller holding `role` may call, as authorizeRpc decides now. hello-ok lists them, so
 * a client offers only the controls the connection may use instead of guessing from role names
 * (an extension role, or an rpcPolicies entry, would defeat the guess).
 */
export function allowedRpcMethods(role: string | undefined, authEnabled: boolean): RpcMethod[] {
  return (Object.keys(RPC_METHOD_MIN_ROLE) as RpcMethod[]).filter((method) => authorizeRpc(method, role, authEnabled).allowed);
}

/** Test hook. */
export function _resetRpcPoliciesForTests(): void {
  _policies.length = 0;
}
