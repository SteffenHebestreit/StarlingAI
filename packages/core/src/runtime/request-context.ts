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

export interface RequestContext {
  /** Authenticated user (JWT subject / username) that owns this tool execution. */
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given request context active for its entire async lifetime. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The active request context, if any. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Convenience: the user that owns the active tool execution, if any. */
export function currentUserId(): string | undefined {
  return storage.getStore()?.userId;
}
