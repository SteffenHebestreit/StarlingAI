/**
 * AG-UI Protocol endpoint
 *
 * POST /api/chat/stream
 * Body: { sessionId?: string, message: string }
 * Auth: Bearer <token>
 *
 * Responds with an SSE stream of AG-UI events:
 *   RUN_STARTED, TEXT_MESSAGE_STARTED, TEXT_MESSAGE_CONTENT,
 *   TOOL_CALL_STARTED, TOOL_CALL_ENDED, OPERATOR_INTERVENTION,
 *   TEXT_MESSAGE_ENDED, RUN_FINISHED
 *
 * Spec: https://docs.ag-ui.com/concepts/events
 */

import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { archiveSession, createSession, resolveSession } from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { DELEGATION_WAIT_CEILING_MS, extendDeadlineForDelegationWait } from "../agent/delegation-budget.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import { roleRank } from "./auth.js";
import type { InterventionNotice } from "../agent/interventions.js";

const TURN_TIMEOUT_SYNTHESIS_GRACE_MS = 65_000;

/**
 * How often to write an SSE comment while the turn produces nothing.
 *
 * This stream is silent for the ENTIRE duration of a delegated sub-agent call — the
 * measured ones run 15.8 minutes — and a silent socket is what every idle timeout on the
 * path is watching for. Node's own fetch (undici) gives up after 300s with
 * UND_ERR_BODY_TIMEOUT, and nginx's proxy_read_timeout defaults to 60s. Both are shorter
 * than one ordinary sub-agent call.
 *
 * That made the failure worse than a dropped view: the disconnect handler below aborts the
 * turn, so a client that timed out CANCELLED the very run it was waiting on, and the
 * gateway recorded it as a sub-agent failure at iteration 0. The dashboard never hit this
 * because it drives turns over the WebSocket RPC channel; the AG-UI endpoint is the
 * documented HTTP integration surface and was unusable for the workload it exists to serve.
 *
 * Fifteen seconds sits comfortably under both defaults. A comment line is the right shape:
 * the SSE grammar ignores it, so no client parses it as an event.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

const log = childLogger("gateway:agui");

// ─── Event helpers ────────────────────────────────────────────────────────────

function sseEvent(res: ServerResponse, event: Record<string, unknown>): void {
  if (res.writableEnded) return; // never write after the stream closed (post-timeout/disconnect)
  const data = JSON.stringify(event);
  res.write(`data: ${data}\n\n`);
}

// ─── Main handler — called from gateway/index.ts ──────────────────────────────

export async function handleAguiStream(
  res: ServerResponse,
  body: { sessionId?: string; message: string },
  caller?: { userId?: string; role?: string },
): Promise<void> {
  const { message, sessionId } = body;
  const userId = caller?.userId;

  if (!message?.trim()) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "message is required" }));
    return;
  }

  // Get or create session — try Redis fallback for cross-instance routing.
  // Create it UNDER the requested id (so session-scoped documents uploaded with
  // that sessionId are in retrieval scope) and attribute it to the authenticated
  // user (so the document-RAG user scope + RBAC match the identity uploads use),
  // mirroring the RPC session.create path. Without both, AG-UI turns ran under a
  // fresh random session with no userId, dropping session/user document scope.
  // resumeArchived: a session parked by the turn watchdog (or the idle sweep) still holds
  // its history and the partial work of the turn that ran out of clock. Without this the
  // createSession fallback below would mint a BRAND-NEW session under the same id and
  // silently drop that transcript. Explicit ("manual") archives stay unresumable.
  let session = sessionId ? await resolveSession(sessionId, { resumeArchived: true }) : undefined;

  // Ownership gate (decided BEFORE we commit to the SSE 200 response): don't let a
  // caller drive a turn on another user's existing session — the same invariant the
  // RPC chat path enforces via canAccessSession. Operators may access any session;
  // unowned sessions and auth-off deployments fall through. Opaque 404 to match the
  // RPC not-found shape and avoid confirming the session id exists.
  if (session && getConfig().auth?.enabled === true) {
    const owner = session.userId;
    const isAdmin = !!caller?.role && roleRank(caller.role) >= roleRank("operator");
    if (owner !== undefined && owner !== userId && !isAdmin) {
      log.warn({ sessionId: session.id, owner, caller: userId ?? "(none)" }, "AG-UI stream denied: session owned by another user");
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "X-Accel-Buffering": "no",  // Disable nginx buffering
  });

  const runId       = randomUUID();
  const messageId   = randomUUID();

  if (!session) {
    session = createSession({
      ...(sessionId ? { sessionId } : {}),
      channel: "webchat:agui",
      ...(userId ? { userId } : {}),
      ...(caller?.role ? { userRole: caller.role } : {}),
    });
  }

  const turnTimeoutMs = getConfig().gateway.turnTimeoutMs;

  sseEvent(res, { type: "RUN_STARTED", runId, threadId: session.id });

  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  let timedOut = false;

  // ONE cleanup for both timers rather than two functions called side by side. There are
  // four teardown paths here, and the comment on the turn-timeout timer below records what
  // happened last time one of them missed a handle: an orphaned timer fired after a normal
  // completion, archived the session and wrote to a closed stream. A heartbeat INTERVAL
  // leaking that way would not fire once, it would fire every 15s forever.
  const cleanupTimers = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (heartbeatHandle) {
      clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
  };

  const handleTurnTimeout = () => {
    if (timedOut || res.writableEnded) return; // already handled / stream already closed
    timedOut = true;
    abortController.abort();
    // "timeout" keeps the parked session resumable (and on the long retention) so the
    // next POST to this thread continues it instead of hitting a not-found.
    archiveSession(session.id, "timeout");
    sseEvent(res, {
      type: "RUN_ERROR",
      runId,
      message: "Turn exceeded the timeout window and did not finish synthesis. The session is parked — send another message to continue it.",
    });
  };

  // Handle client disconnect
  res.on("close", () => {
    cleanupTimers();
    abortController.abort();
    log.debug({ runId }, "AG-UI client disconnected");
  });

  // A SINGLE turn-timeout timer (+GRACE for synthesis), armed after the close
  // handler so disconnect cleanup is wired first. A second timer here previously
  // overwrote the handle and orphaned the first, which then fired after a normal
  // completion — spuriously archiving the session and writing to a closed stream.
  // D5 PARITY: the gateway clock must pause for the time the turn spends WAITING ON A CHILD,
  // or it guillotines a build whose runtime budget legitimately stopped counting.
  //
  // rpc.ts has done this since D5; this path never did, and run d5747607 is the bill. A resume
  // build was making real progress — six successful edit_file calls in its last iteration, the
  // artifact grown from 9,410 to 13,474 bytes — and the turn was aborted at 31:05, which is
  // exactly turnTimeoutMs (30 min) plus the synthesis grace. The delegation alone had run 25
  // of those minutes. Worse, an aborted turn never reaches finalization, so QA and the artifact
  // probe both logged not_run: the clock did not just kill the build, it killed the only gate
  // that would have reported the build unfinished.
  //
  // Same shape as the RPC path deliberately, including the absolute ceiling — a turn may be
  // extended by delegation wait, never made immortal by it.
  let gatewayDeadlineMs = 0;
  let gatewayDeadlineCeilingMs = 0;
  if (turnTimeoutMs > 0) {
    const armedAt = Date.now();
    gatewayDeadlineMs = armedAt + turnTimeoutMs + TURN_TIMEOUT_SYNTHESIS_GRACE_MS;
    gatewayDeadlineCeilingMs = armedAt + DELEGATION_WAIT_CEILING_MS + TURN_TIMEOUT_SYNTHESIS_GRACE_MS;
  }
  const extendGatewayDeadline = (ms: number): void => {
    if (gatewayDeadlineMs <= 0 || timedOut || res.writableEnded || ms <= 0) return;
    gatewayDeadlineMs = extendDeadlineForDelegationWait(gatewayDeadlineMs, ms, gatewayDeadlineCeilingMs);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(handleTurnTimeout, Math.max(0, gatewayDeadlineMs - Date.now()));
  };

  timeoutHandle = setTimeout(handleTurnTimeout, turnTimeoutMs + TURN_TIMEOUT_SYNTHESIS_GRACE_MS);

  // Armed next to the turn timer, and torn down by the same cleanup. `unref` so a live
  // heartbeat can never be the reason the process stays up.
  heartbeatHandle = setInterval(() => {
    if (res.writableEnded) {
      cleanupTimers();
      return;
    }
    res.write(": heartbeat\n\n");
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatHandle.unref?.();

  try {
    let textStarted = false;
    let streamedMeaningfulText = false;

    const turnResult = await runTurn({
      session,
      userMessage: message,
      signal: abortController.signal,
      // Keep the gateway's hard timeout in lockstep with the runtime's delegation-wait
      // exclusion. Without this the two clocks disagree and the shorter one wins.
      onDelegationWaitMs: extendGatewayDeadline,

      onChunk: (text) => {
        if (!textStarted) {
          sseEvent(res, { type: "TEXT_MESSAGE_STARTED", messageId, role: "assistant" });
          textStarted = true;
        }
        if (text && text.trim().length > 0) streamedMeaningfulText = true;
        sseEvent(res, { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text });
      },

      onReasoning: (text) => {
        // Chain-of-thought stream. Emitted as a distinct event so clients can
        // render it in a collapsible "thinking" panel separate from the answer.
        sseEvent(res, { type: "THINKING_TEXT_MESSAGE_CONTENT", messageId, delta: text });
      },

      onToolCall: (toolCallId, name, args) => {
        sseEvent(res, { type: "TOOL_CALL_STARTED", toolCallId, toolCallName: name, parentMessageId: messageId, args });
      },

      onToolResult: (toolCallId, name, result, metadata) => {
        sseEvent(res, { type: "TOOL_CALL_ENDED", toolCallId, toolCallName: name, output: result, metadata });
      },

      onIntervention: (notice: InterventionNotice) => {
        sseEvent(res, { type: "OPERATOR_INTERVENTION", runId, notice });
      },
    });

    cleanupTimers();
    if (timedOut) return;

    // Never leave the user with a silent/empty reply. If streaming produced no
    // meaningful (non-whitespace) text — which happens when a turn is blocked,
    // or when the model emitted only whitespace before deadlocking on a
    // guardrail — surface the final response, or a generic fallback if that is
    // also empty. (A whitespace-only stream previously set textStarted=true and
    // suppressed the blocked-reason fallback, leaving a blank message.)
    if (!streamedMeaningfulText) {
      const fallback = turnResult.response && turnResult.response.trim().length > 0
        ? turnResult.response
        : turnResult.blocked
          ? "I couldn't complete that request this turn — I got stuck routing it. Please rephrase or try again, and I'll take another pass."
          : "";
      if (fallback) {
        if (!textStarted) {
          sseEvent(res, { type: "TEXT_MESSAGE_STARTED", messageId, role: "assistant" });
          textStarted = true;
        }
        sseEvent(res, { type: "TEXT_MESSAGE_CONTENT", messageId, delta: fallback });
        streamedMeaningfulText = fallback.trim().length > 0;
      }
    }

    if (textStarted) {
      sseEvent(res, { type: "TEXT_MESSAGE_ENDED", messageId });
    }

    sseEvent(res, { type: "RUN_FINISHED", runId, threadId: session.id });

  } catch (err) {
    cleanupTimers();
    if (timedOut) return;
    if (!abortController.signal.aborted) {
      log.error({ err, runId }, "AG-UI run error");
      sseEvent(res, { type: "RUN_ERROR", runId, message: String(err) });
    }
  } finally {
    cleanupTimers();
    res.end();
  }
}
