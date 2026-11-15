/**
 * Core Extension SDK — first-party extension packages compiled with the repo.
 *
 * This is the primary mechanism for FORKS to add domain functionality without
 * editing upstream files (docs/fork-boilerplate-plan.md WS3). An extension is
 * a directory under `packages/core/src/extensions/<name>/` whose `index.ts`
 * default-exports a `defineCoreExtension({...})` manifest. The loader
 * discovers and registers extensions at boot — no `index.ts` edits, no
 * registry edits, no tier-map edits.
 *
 * How this differs from the runtime Plugin SDK (`src/plugin/`):
 *
 *   Plugin SDK                          Extension SDK
 *   ─ user-installed at runtime         ─ committed to the (fork's) repo
 *   ─ loaded from ~/<state>/plugins     ─ compiled + type-checked with core
 *   ─ untrusted: fixed Tier 2,          ─ trusted first-party code: declares
 *     per-call approval, sandboxed        explicit tiers, routes, guardrails,
 *   ─ tools only                          roles, audit events, boot hooks
 *
 * Trust boundary: extensions execute arbitrary code in-process — exactly like
 * any other file in the repo. The tier-declaration privilege is justified by
 * that equivalence; the loader refuses tier declarations that shadow
 * built-in tools, and runtime config can still disable any extension tool via
 * `tools.disabledGroups` / `tools.disabledTools` (each extension's tools
 * default to the group named after the extension).
 */

import type { ToolCallAuthorizer, ToolContext, ToolEffect, ToolResult } from "../tools/registry.js";
import { ToolTier } from "../guardrails/tool-tiers.js";
import type { GuardrailResult } from "../guardrails/input.js";
import type { Identity } from "../runtime/accounts.js";
import type { Logger } from "pino";
import type { RoutePolicy as RoutePolicyDef } from "../gateway/route-policies.js";
import type { RpcPolicyDef } from "../gateway/rpc-policy.js";
import type { LlmBoundaryTransformer } from "../providers/llm-boundary.js";

export type { LlmBoundaryTransformer };

export type { RoutePolicyDef, RpcPolicyDef };

// Re-exports so an extension only needs one import for the common cases.
export { ToolTier };
export type { ToolCallAuthorizer, ToolContext, ToolEffect, ToolResult, GuardrailResult };

/** Extension name: lowercase, short, used as namespace + default tool group. */
export const EXTENSION_NAME_PATTERN = /^[a-z][a-z0-9-]{1,32}$/;
/** Bare audit-event name; stored namespaced as `<ext>.<event>`. */
export const EXTENSION_AUDIT_EVENT_PATTERN = /^[a-z][a-z0-9_]{1,48}$/;

/**
 * Tool definition for extensions. Unlike plugin tools the tier is declared
 * explicitly (trusted first-party code) and merges into the central tier
 * registry at load time.
 */
export interface ExtensionToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * Checked before the approval prompt (ToolHandler.refuse): the reason this call cannot work, or
   * nothing. A check inside `execute` runs only after the person approved the call. One that is
   * not a function leaves the tool out (logged at boot); the rest of the extension loads.
   */
  refuse?: (args: Record<string, unknown>, ctx: ToolContext) => string | undefined | Promise<string | undefined>;
  /** What the tool does outside the workspace (ToolHandler.effect, ADR-005). */
  effect?: ToolEffect;
  /** Explicit tier (0–3). FOUR_BLOCKED is rejected — don't ship a tool to block it. */
  tier: ToolTier;
  /** Defaults to false. */
  requiresPerCallApproval?: boolean;
  /** Defaults to false. */
  requiresSandbox?: boolean;
  /** Tool group for config-driven disabling. Defaults to the extension name. */
  group?: string;
  embeddingDescription?: string;
  costHint?: "low" | "medium" | "high";
  latencyHint?: "low" | "medium" | "high";
  timeoutMs?: number;
}

/**
 * Role contributed by an extension (e.g. a medical fork's doctor/mfa/patient).
 * Registration makes the role *known* — surfaced via /api/product so the web
 * shell can render badges, and available to gateway RBAC checks. Enforcement
 * semantics stay in the consuming code.
 */
export interface ExtensionRoleDef {
  /** Role id as carried in JWT `role` claims. */
  name: string;
  description: string;
  /**
   * Authority rank for greater-or-equal checks: higher outranks lower.
   * Convention: viewer-like = 10, operator-like = 50, admin-like = 100.
   */
  rank: number;
  /** Optional UI hint for the web shell badge. */
  badge?: { label: string; color?: string };
}

/**
 * Guardrail hooks appended AFTER the built-in pipeline stages. Returning
 * `allowed: false` blocks exactly like a built-in guardrail. Hooks must be
 * fast and side-effect free; heavy work belongs in tools.
 */
export interface ExtensionGuardrailHooks {
  /** Layer 1 — user input before it reaches the LLM. */
  checkInput?: (input: string) => GuardrailResult;
  /** Layer 3 — model output before it reaches the user. May rewrite via `redacted`. */
  checkOutput?: (output: string) => GuardrailResult & { redacted?: string };
}

/**
 * Pluggable credential backend. When an extension registers one, the CORE
 * /api/auth/login and /api/auth/me routes authenticate against it instead of
 * the config-file user list — forks get their own user store without touching
 * gateway code. Exactly one provider may be registered per process.
 */
export interface ExtensionAuthUser {
  /** Stable id — becomes the JWT `sub`. */
  id: string;
  username: string;
  role: string;
  displayName?: string;
  /** Extra JWT claims (e.g. a medical fork's kvnr). Keep small + non-secret. */
  claims?: Record<string, unknown>;
}

export interface ExtensionAuthProvider {
  /** Validate credentials; null = reject. */
  verifyCredentials(username: string, password: string): Promise<ExtensionAuthUser | null>;
  /** Resolve a token subject back to a user; null = account gone (401). */
  getUserById(id: string): ExtensionAuthUser | null;
}

/**
 * One agent run about to start, as an {@link CoreExtension.authorizeAgentRun} hook sees it.
 * `role` is the role the run answers to: the caller's when the surface that started the run knows
 * it, else, for a run done for an account that carries none (a queued job, a scheduled run), the
 * role the auth store holds for that account now. It is absent when no role is known (a channel, a
 * cron or channel trigger, a federation peer, an identity-provider account's queued run, an account
 * that no longer signs in). `identity` is the account or principal the run is done for, when there
 * is one.
 */
export interface ExtensionAgentRun {
  agentName: string;
  agentConfig: { workspaceAccess?: string };
  role?: string;
  identity?: Identity;
}

/** The reason an agent run is refused, or nothing to let it through. */
export type ExtensionAgentRunAuthorizer = (run: ExtensionAgentRun) => string | undefined | Promise<string | undefined>;

/** Per-extension context handed to routes/boot/shutdown. */
export interface CoreExtensionContext {
  /** Extension name (= directory name). */
  readonly name: string;
  /** Child logger namespaced `ext:<name>`. */
  readonly log: Logger;
  /**
   * The extension's config slice (`extensions.<name>` from the root config),
   * parsed through `configSchema` when one is declared, raw otherwise.
   * Available from the boot phase onward.
   */
  readonly config: unknown;
}

/**
 * Minimal structural interface of the gateway's Hono app — kept structural so
 * the SDK doesn't re-export Hono types, but assignable from the real app.
 */
export interface ExtensionRouteApp {
  get(path: string, ...handlers: Array<(...args: never[]) => unknown>): unknown;
  post(path: string, ...handlers: Array<(...args: never[]) => unknown>): unknown;
  put(path: string, ...handlers: Array<(...args: never[]) => unknown>): unknown;
  delete(path: string, ...handlers: Array<(...args: never[]) => unknown>): unknown;
}

export interface CoreExtension {
  /** Unique id matching EXTENSION_NAME_PATTERN. Namespace for groups, audit events, routes. */
  name: string;
  /** Semver-ish; surfaced in listings, not enforced. */
  version: string;
  description?: string;
  /** Tools registered under their bare names with the declared tiers. */
  tools?: ExtensionToolDef[];
  /**
   * Veto any tool call, core or extension, before it runs: return the reason to refuse it, or
   * nothing to let it through. Asked for every call that reaches the tool registry (a chat turn's,
   * a sub-agent's, a workflow step's, an MCP client's), after the blocked-tier and registration
   * checks and BEFORE the tool's own `refuse` and any approval prompt, so a refused call never
   * shows an approval card. `ctx.userRole` is the role the call answers to, inherited through
   * every delegation; it is unset where nobody signed in (a channel, a cron run). Hooks of all
   * extensions run in load order and the first refusal wins; a hook that throws refuses the call,
   * and one that is not a function refuses every call (logged at boot, the extension still loads).
   * A refusal is audited as `tool_call_refused` with the tool, the role and the extension, never
   * the arguments. Keep it fast and side-effect free.
   */
  authorizeToolCall?: ToolCallAuthorizer;
  /**
   * Audit event names this extension emits. Logged as `<name>.<event>`
   * (e.g. "mfa.patient_data_accessed") — the namespace keeps fork events
   * separate from the upstream union forever.
   */
  auditEvents?: string[];
  /** Roles this extension contributes to the auth model. */
  roles?: ExtensionRoleDef[];
  /** Credential backend consumed by the core /api/auth routes. One per process. */
  authProvider?: ExtensionAuthProvider;
  /**
   * Decide whether an agent run may start. Asked for every sub-agent run, whichever surface started
   * it (delegate_to_agent, --agent, run_workflow, A2A, MCP, a queued job's or a scheduled run's
   * turn), before any model call and before the core role floor for agents with workspaceAccess
   * "full" (`agents.fullScopeMinRole`). Return the
   * reason to refuse the run (it fails with that text and nothing runs), or undefined to leave the
   * decision to the core checks. Hooks of all extensions run in load order and the first refusal
   * wins; a hook that throws refuses the run, and one that is not a function refuses every run
   * (logged at boot, the extension still loads). Keep it fast and side-effect free: routing asks it
   * too, for each agent, so search_agents and list_agents do not offer an agent it would refuse.
   */
  authorizeAgentRun?: ExtensionAgentRunAuthorizer;
  /**
   * Embedding-reranker routing keywords: tools whose names match `pattern`
   * gain `keywords` in their embedding text, improving semantic routing for
   * domain vocabulary (e.g. German medical terms → mfa_* tools).
   */
  toolKeywords?: Array<{ pattern: RegExp; keywords: string[] }>;
  /**
   * LLM-boundary transformer: rewrite the provider-bound message view
   * (beforeRequest, fails closed) and non-streaming model text
   * (afterResponse, fails open). See providers/llm-boundary.ts.
   */
  llmBoundary?: LlmBoundaryTransformer;
  /** Guardrail pipeline hooks, appended after built-ins. */
  guardrails?: ExtensionGuardrailHooks;
  /**
   * Declarative RBAC for gateway routes (core or extension ones), enforced
   * before handlers run on every `/api/*` route, on the surfaces the Node
   * server answers itself (`POST /api/chat/stream`, `/mcp`, `/a2a/*`,
   * `/.well-known/agent-card.json`) and on the WebSocket upgrades `/ws` and
   * `/ws/browser-vnc/*` (matched as `GET`). Each policy sets exactly one of
   * `roles` (only these roles pass; no token → 401) or `denyRoles` (these
   * roles get 403; everyone else, anonymous callers included, is passed on to
   * the next matching policy, core's own included, then the route's own auth).
   * A malformed policy is logged and refuses every caller on its path; it does
   * not fail the extension's load. See gateway/route-policies.ts for pattern
   * syntax and which policies decide.
   */
  routePolicies?: RoutePolicyDef[];
  /**
   * Who may call which WebSocket RPC method (/ws), over the gateway's per-method minimum roles.
   * `{ method, roles }` replaces the default for the methods it matches (e.g. opens chat to a role
   * of this extension below operator, with the methods its turns need: docs/forking.md);
   * `{ method, denyRoles }` refuses the listed roles and leaves the rest to the default. `method`
   * is exact, "prefix.*" or "*"; first match wins, in load order. A malformed policy is logged and
   * refuses its method, or every method, to every caller; it does not fail the extension's load.
   * See gateway/rpc-policy.ts.
   */
  rpcPolicies?: RpcPolicyDef[];
  /**
   * Mount gateway routes. Called once during gateway construction, AFTER all
   * core routes (extensions cannot shadow core endpoints). Convention:
   * prefix with `/api/<name>/`.
   */
  registerRoutes?: (app: ExtensionRouteApp, ctx: CoreExtensionContext) => void;
  /**
   * Zod-compatible schema for the `extensions.<name>` config slice. When
   * present the slice is validated at boot; a validation error disables the
   * extension's boot hook and logs loudly, but does not abort the gateway.
   */
  configSchema?: { parse: (value: unknown) => unknown };
  /** Async init (db schemas, caches, background loads). Runs during startup, before the gateway listens. */
  boot?: (ctx: CoreExtensionContext) => void | Promise<void>;
  /** Graceful-shutdown hook. */
  shutdown?: () => void | Promise<void>;
}

/** Identity helper — typed authoring surface, no runtime behavior. */
export function defineCoreExtension<T extends CoreExtension>(extension: T): T {
  return extension;
}

// ── Runtime registries (populated by the loader) ────────────────────────────

export interface LoadedExtensionRecord {
  name: string;
  version: string;
  description?: string;
  toolNames: string[];
  auditEvents: string[];
  roles: ExtensionRoleDef[];
  loadedAt: string;
  source: string;
}

const _extensions = new Map<string, LoadedExtensionRecord>();
const _roles = new Map<string, ExtensionRoleDef>();
const _auditEvents = new Set<string>();
const _guardrailHooks: Array<{ extension: string; hooks: ExtensionGuardrailHooks }> = [];
const _agentRunAuthorizers: Array<{ extension: string; authorize: ExtensionAgentRunAuthorizer }> = [];
let _authProvider: { extension: string; provider: ExtensionAuthProvider } | null = null;

/** @internal loader-only */
export function _recordLoadedExtension(record: LoadedExtensionRecord, ext: CoreExtension): void {
  _extensions.set(record.name, record);
  for (const role of ext.roles ?? []) _roles.set(role.name, role);
  for (const event of record.auditEvents) _auditEvents.add(event);
  if (ext.guardrails) _guardrailHooks.push({ extension: record.name, hooks: ext.guardrails });
  if (ext.authorizeAgentRun) _agentRunAuthorizers.push({ extension: record.name, authorize: ext.authorizeAgentRun });
  if (ext.authProvider) {
    if (_authProvider && _authProvider.extension !== record.name) {
      throw new Error(
        `extension "${record.name}" declares an authProvider but "${_authProvider.extension}" already registered one — only one credential backend per process`,
      );
    }
    _authProvider = { extension: record.name, provider: ext.authProvider };
  }
}

/** The registered credential backend, if any extension declared one. */
export function getExtensionAuthProvider(): ExtensionAuthProvider | null {
  return _authProvider?.provider ?? null;
}

/** Metadata for loaded extensions (dashboard / diagnostics). */
export function listLoadedExtensions(): LoadedExtensionRecord[] {
  return [..._extensions.values()];
}

/** All extension-contributed roles, e.g. for /api/product and RBAC checks. */
export function listExtensionRoles(): ExtensionRoleDef[] {
  return [..._roles.values()];
}

export function getExtensionRole(name: string): ExtensionRoleDef | undefined {
  return _roles.get(name);
}

/** True when `<ext>.<event>` was declared by a loaded extension. */
export function isDeclaredExtensionAuditEvent(namespacedEvent: string): boolean {
  return _auditEvents.has(namespacedEvent);
}

/** Guardrail hooks from all loaded extensions, in load order. */
export function getExtensionGuardrailHooks(): ReadonlyArray<{ extension: string; hooks: ExtensionGuardrailHooks }> {
  return _guardrailHooks;
}

/** Agent-run authorizers from all loaded extensions, in load order. */
export function getExtensionAgentRunAuthorizers(): ReadonlyArray<{ extension: string; authorize: ExtensionAgentRunAuthorizer }> {
  return _agentRunAuthorizers;
}

/** Test hook: clear all extension registries. */
export function _resetExtensionsForTests(): void {
  _extensions.clear();
  _roles.clear();
  _auditEvents.clear();
  _guardrailHooks.length = 0;
  _agentRunAuthorizers.length = 0;
  _authProvider = null;
}
