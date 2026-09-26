/**
 * Request-scoped execution context (AsyncLocalStorage).
 *
 * Carries the authenticated user that owns the currently-executing tool call
 * across async boundaries WITHOUT threading it through every function signature.
 * Set once inside executeTool from ToolContext.userId; read by downstream
 * clients (e.g. the mail-service HTTP client) to forward identity so shared
 * resources can be access-controlled per user.
 *
 * Undefined store / userId = single-user / auth-disabled mode (no scoping).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { UserInputChannel } from "../agent/user-input.js";

export interface RequestContext {
  /** Authenticated user (JWT subject / username) that owns this tool execution. */
  userId?: string;
  /**
   * Workspace visibility zone of the executing agent. "generated" confines file
   * tools to the working zones (generated/ + uploads/); "full" / undefined means
   * the whole workspace (runtime internals, core agents, gateway endpoints).
   */
  workspaceScope?: "full" | "generated";
  /**
   * A PRE-RESOLVED on-disk user-scope segment (already the exact `<base>/users/<segment>`
   * directory name). Set by background sweeps that enumerate existing per-user buckets so
   * userScopedDir targets that bucket VERBATIM instead of re-deriving it from a userId —
   * safeUserSegment is a lossy hash and must never be applied to its own output. Takes
   * precedence over userId for user-scope path resolution.
   */
  userScopeSegment?: string;
  /**
   * The session this work belongs to — the main turn's session id, or a sub-agent's
   * own `sub:<parent>:<agent>:<ts>` id. Provider rows carry no session of their own
   * (both emitters passed only `{severity}`, so every `provider_model_call` row in the
   * audit store has `session_id` NULL and model calls cannot be joined to the turn or
   * agent that issued them). Set here so the emitters can read it ambiently.
   */
  sessionId?: string;
  /** Which agent is running: "main" for the orchestrator, else the sub-agent's name. */
  agentName?: string;
  /** Coarse origin of the work, for attributing provider rows: see {@link RequestCallSite}. */
  callSite?: RequestCallSite;
  /**
   * The interactive chat this work answers to, set by runTurn for a dashboard turn. It rides the
   * context rather than the ToolContext so every in-process delegation path (there are many, and
   * each builds its own options) hands it down without being touched; a surface with nobody to
   * ask simply never sets it. See agent/user-input-broker.ts.
   */
  userInput?: UserInputChannel;
  /**
   * The top-level turn this work belongs to, set by runTurn for every turn and inherited by
   * everything it runs; a gateway sets it around runTurn so its own clock and the runtime's name the
   * same turn. Human waits carry it, so a wait a stopped turn left open holds no clock of the next
   * turn on the session. Only interactive chat turns had an id to carry (userInput.turnId): an
   * AG-UI or --auto turn's waits named none and held every later turn (review of round 1, B #7).
   */
  turnId?: string;
  /**
   * The chat.send request id of the turn this work belongs to, set by runTurn from
   * RunTurnOptions.requestId and never inherited by a nested turn. Every history message the turn
   * writes carries it (AgentSession.addMessage), so a transcript entry names its own turn: the web
   * told turns apart by their text, and a second tab re-sending the same words left a message
   * "Queued" under the wrong one. Metadata only; the model never reads it.
   */
  chatRequestId?: string;
  /** The model's id for the tool call executing right now, set by executeTool, so a question the
   *  tool raises can be shown next to that call. */
  toolCallId?: string;
  /**
   * English name of the language the person wrote this turn in ("German"), when it can be told —
   * set by runTurn from the user's message (or, for a message with no language of its own, the
   * previous reply) and inherited by nested turns. Only FIXED text reads it: a status line or a
   * backstop message that no model writes. Model-written replies follow the reply-language rule
   * instead, which also honours a language the user asked for.
   */
  userMessageLanguage?: string;
}

/**
 * Coarse origin of a model call. Deliberately small and closed: it exists to make
 * `provider_model_call` rows groupable ("which calls were routing judges?"), not to
 * describe the call site precisely.
 */
export type RequestCallSite =
  | "main_turn"
  | "sub_agent"
  | "routing_tier"
  | "synthesis"
  | "qa"
  | "background"
  /** The prompt-cache warm-keeper between turns (agent/cache-warmer.ts). */
  | "cache_warm"
  /** An image analysis call (tools/multimodal.ts analyzeImageBytes). */
  | "vision";

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given request context active for its entire async lifetime. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Convenience: the user that owns the active tool execution, if any. */
export function currentUserId(): string | undefined {
  return storage.getStore()?.userId;
}

/** Convenience: the workspace zone of the active tool execution, if any. */
export function currentWorkspaceScope(): "full" | "generated" | undefined {
  return storage.getStore()?.workspaceScope;
}

/** Convenience: a pre-resolved on-disk user-scope segment, if a sweep set one. */
export function currentUserScopeSegment(): string | undefined {
  return storage.getStore()?.userScopeSegment;
}

/**
 * The whole ambient context, for callers that need to EXTEND it rather than read one
 * field. Returns the live store object: treat it as read-only and spread it, never mutate
 * it (the one sanctioned mutation is {@link attachRequestSessionId}).
 */
export function currentRequestContext(): Readonly<RequestContext> | undefined {
  return storage.getStore();
}

/** The session that owns the active work (main turn or sub-agent run), if any. */
export function currentSessionId(): string | undefined {
  return storage.getStore()?.sessionId;
}

/** The chat.send request id of the turn doing the active work, if a chat started it. */
export function currentChatRequestId(): string | undefined {
  return storage.getStore()?.chatRequestId;
}

/** The agent running the active work ("main" for the orchestrator), if any. */
export function currentAgentName(): string | undefined {
  return storage.getStore()?.agentName;
}

/** The coarse origin of the active work, if any. */
export function currentCallSite(): RequestCallSite | undefined {
  return storage.getStore()?.callSite;
}

/**
 * Attribution for an audit row emitted from ambient context.
 *
 * `sessionId` goes in the row's identity column (so it joins to the turn); the other
 * two are data fields. Returns empty objects when no context is active, so a caller
 * can spread both unconditionally.
 */
export function currentCallAttribution(): {
  opts: { sessionId?: string };
  data: { agentName?: string; callSite?: RequestCallSite };
} {
  const store = storage.getStore();
  return {
    opts: store?.sessionId ? { sessionId: store.sessionId } : {},
    data: {
      ...(store?.agentName ? { agentName: store.agentName } : {}),
      ...(store?.callSite ? { callSite: store.callSite } : {}),
    },
  };
}

/**
 * Attach a session id to the ALREADY-ACTIVE context.
 *
 * A sub-agent's session id is derived inside its run (it embeds a timestamp), after the
 * context that must carry it has been established. The store is a plain object held by
 * AsyncLocalStorage, so mutating it in place is visible to everything running inside the
 * same `runWithRequestContext` — no second wrapper, no re-entry. No-op when no context is
 * active or when an id is already set (a nested run establishes its own store first).
 */
export function attachRequestSessionId(sessionId: string): void {
  const store = storage.getStore();
  if (store && !store.sessionId) store.sessionId = sessionId;
}

/**
 * Run `fn` under a child context that inherits the ambient identity and overrides only
 * the attribution fields. Used by call sites that want their provider rows labelled
 * (a routing-tier judge, a synthesis call) without disturbing user/workspace scoping.
 */
export function runWithCallAttribution<T>(
  attribution: { agentName?: string; callSite?: RequestCallSite; sessionId?: string },
  fn: () => T,
): T {
  const store = storage.getStore();
  return storage.run({ ...(store ?? {}), ...attribution }, fn);
}
