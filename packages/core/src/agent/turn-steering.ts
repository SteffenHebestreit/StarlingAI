/**
 * Mid-turn user steering — let the user add guidance WHILE a turn is running,
 * without aborting it (Stop already aborts).
 *
 * On the slow single-GPU backend a turn can run for many minutes (research +
 * build; an image_sourcer run took 14 min). Today the only mid-turn control is
 * Stop. This lets the user instead say "those URLs are wrong, stop guessing" or
 * "also add a summary slide" and have it folded into the SAME turn at the next
 * safe point, instead of waiting it out or losing the work.
 *
 * Mechanics mirror the operator-stop latch (long-running-generation.ts): a
 * per-root (turn) queue the runtime DRAINS between tool-loop iterations and
 * appends to history as an authoritative user message before the next model
 * call. Scoped to the root session id so steering reaches the orchestrator turn
 * regardless of which sub-agent is mid-flight. Only queues while a turn is
 * actually active, so a stray message never leaks into the next turn.
 */

import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("agent:turn-steering");

/** Strip `sub:` nesting hops to the root (turn) session id. Mirrors rootOf in
 *  long-running-generation.ts so steering is scoped to the whole turn. */
function rootOf(sessionId: string): string {
  let current = sessionId;
  while (current.startsWith("sub:")) {
    const inner = current.slice("sub:".length);
    const lastColon = inner.lastIndexOf(":");
    if (lastColon === -1) return inner;
    const secondLastColon = inner.lastIndexOf(":", lastColon - 1);
    if (secondLastColon === -1) return inner;
    current = inner.slice(0, secondLastColon);
  }
  return current;
}

class TurnSteeringManager {
  /** root (turn) session id → queued steering messages, in arrival order. */
  private _queues = new Map<string, string[]>();
  /** root session ids with an in-flight turn (so we only queue for live turns). */
  private _active = new Set<string>();

  /** Mark the start of a turn; clears any stale queue for the root. */
  markTurnActive(sessionId: string): void {
    const root = rootOf(sessionId);
    this._active.add(root);
    this._queues.delete(root);
  }

  /** Mark a turn finished; drops its active flag and any unconsumed queue. */
  markTurnDone(sessionId: string): void {
    const root = rootOf(sessionId);
    this._active.delete(root);
    this._queues.delete(root);
  }

  /** Is a turn currently running for this (root) session? */
  isTurnActive(sessionId: string): boolean {
    return this._active.has(rootOf(sessionId));
  }

  /**
   * Queue a steering message — but ONLY if a turn is actually in flight for the
   * session. Returns true when queued; false when no turn is active (the caller
   * should then treat the text as a normal new message). Prevents a stray
   * message from leaking into a later turn.
   */
  enqueueIfActive(sessionId: string, text: string): boolean {
    const trimmed = (text ?? "").trim();
    if (!trimmed) return false;
    const root = rootOf(sessionId);
    if (!this._active.has(root)) return false;
    const queue = this._queues.get(root) ?? [];
    queue.push(trimmed);
    this._queues.set(root, queue);
    logAudit("turn_steering_enqueued", {
      length: trimmed.length,
      queued: queue.length,
    }, { sessionId: root, severity: "info" });
    log.info({ root, queued: queue.length }, "Mid-turn steering message queued");
    return true;
  }

  /** Take and clear all queued steering messages for a (root) session. */
  drain(sessionId: string): string[] {
    const root = rootOf(sessionId);
    const queue = this._queues.get(root);
    if (!queue || queue.length === 0) return [];
    this._queues.set(root, []);
    return queue;
  }

  hasPending(sessionId: string): boolean {
    const queue = this._queues.get(rootOf(sessionId));
    return Boolean(queue && queue.length > 0);
  }

  /** Reset for tests. */
  resetForTests(): void {
    this._queues.clear();
    this._active.clear();
  }
}

// Singleton
export const turnSteeringManager = new TurnSteeringManager();
