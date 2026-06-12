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

import type { ToolContext, ToolResult } from "../tools/registry.js";
import { ToolTier } from "../guardrails/tool-tiers.js";
import type { GuardrailResult } from "../guardrails/input.js";
import type { Logger } from "pino";
import type { RoutePolicy as RoutePolicyDef } from "../gateway/route-policies.js";

export type { RoutePolicyDef };

// Re-exports so an extension only needs one import for the common cases.
export { ToolTier };
export type { ToolContext, ToolResult, GuardrailResult };

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
   * Embedding-reranker routing keywords: tools whose names match `pattern`
   * gain `keywords` in their embedding text, improving semantic routing for
   * domain vocabulary (e.g. German medical terms → mfa_* tools).
   */
  toolKeywords?: Array<{ pattern: RegExp; keywords: string[] }>;
  /** Guardrail pipeline hooks, appended after built-ins. */
  guardrails?: ExtensionGuardrailHooks;
  /**
   * Declarative RBAC for gateway routes (core or extension ones): role-name
   * lists per route pattern, enforced by the gateway's policy gate before
   * handlers run. See gateway/route-policies.ts for pattern syntax.
   */
  routePolicies?: RoutePolicyDef[];
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
let _authProvider: { extension: string; provider: ExtensionAuthProvider } | null = null;

/** @internal loader-only */
export function _recordLoadedExtension(record: LoadedExtensionRecord, ext: CoreExtension): void {
  _extensions.set(record.name, record);
  for (const role of ext.roles ?? []) _roles.set(role.name, role);
  for (const event of record.auditEvents) _auditEvents.add(event);
  if (ext.guardrails) _guardrailHooks.push({ extension: record.name, hooks: ext.guardrails });
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

/** Test hook: clear all extension registries. */
export function _resetExtensionsForTests(): void {
  _extensions.clear();
  _roles.clear();
  _auditEvents.clear();
  _guardrailHooks.length = 0;
  _authProvider = null;
}
