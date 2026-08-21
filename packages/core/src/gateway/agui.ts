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
import { archiveSession, createSession, getSessionRecord, resolveSession } from "../agent/session.js";
import { longRunningGenerationManager } from "../agent/long-running-generation.js";

/** How often the watchdog re-checks a turn it suspended for an operator grant. Same cadence
 *  as the RPC surface, so the two clocks behave identically under a grant. */
const GRANTED_TURN_RECHECK_MS = 60_000;
import { runTurn } from "../agent/runtime.js";
import { extendDeadlineForDelegationWait, resolveDelegationWaitCeilingMs } from "../agent/delegation-budget.js";
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
  // READ THE OWNER BEFORE WAKING THE SESSION UP. `resolveSession(..., resumeArchived)` is not
  // a read: it clears archivedAt, resets endLogged, persists, hydrates from Redis and writes a
  // `session.resumed` audit entry. Doing that first meant a request the gate below DENIES had
  // already un-parked the victim's session. getSessionRecord answers the ownership question
  // without touching anything; the resume happens once the caller is allowed to have it.
  const existingRecord = sessionId ? getSessionRecord(sessionId) : undefined;
  if (existingRecord && getConfig().auth?.enabled === true) {
    const owner = existingRecord.userId;
    const isAdmin = !!caller?.role && roleRank(caller.role) >= roleRank("operator");
    if (owner !== undefined && owner !== userId && !isAdmin) {
      log.warn({ sessionId, owner, caller: userId ?? "(none)" }, "AG-UI stream denied: session owned by another user");
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }
  }
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
  // Last sign of life from the turn — its own text, its reasoning, or any delegate's
  // progress. The clock below consults this instead of deciding on elapsed time alone.
  let lastTurnActivityAt = 0;
  const turnStartedAt = Date.now();
  /** How long a quiet turn may sit before the clock stops deferring. */
  const GATEWAY_LIVENESS_RECHECK_MS = 300_000;
  /** Absolute ceiling, so a chatty-but-stuck turn cannot defer forever. */
  const MAX_GATEWAY_TURN_MS = 86_400_000;
  const noteTurnActivity = (): void => { lastTurnActivityAt = Date.now(); };

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
    // AN OPERATOR GRANT THIS CLOCK DOES NOT KNOW ABOUT IS NOT A GRANT. rpc.ts and runtime.ts
    // both suspend for `isTurnUnbounded`; this one did not, so the surface a browser actually
    // streams from could still guillotine a turn the operator had explicitly told to take as
    // long as it needs. Re-arm rather than cancel, so the watchdog resumes if the grant clears.
    if (longRunningGenerationManager.isTurnUnbounded(session.id)) {
      log.info({ runId, sessionId: session.id }, "AG-UI turn watchdog suspended — operator unbounded grant");
      timeoutHandle = setTimeout(handleTurnTimeout, GRANTED_TURN_RECHECK_MS);
      return;
    }
    // THE EIGHTH CLOCK, AND THE LAST ONE STILL DECIDING ON ELAPSED TIME ALONE.
    //
    // Validation run 3 was cancelled at 31:05 — five seconds after the runtime supervisor had
    // judged it on_track and extended, and while the delegate was mid-composition. The
    // sub-agent deadline, the runtime turn deadline and the soft deadline all defer to
    // evidence now; this one aborted regardless, so all three deferrals were overruled by the
    // outermost timer that could not see any of it.
    //
    // It can see it now: every reasoning chunk and tool call from a delegate arrives here as
    // a progress event. A stream that delivered something within the recheck window is alive;
    // one that has gone quiet stops deferring on the next check, and the absolute ceiling
    // still bounds the whole thing.
    const sinceProgressMs = lastTurnActivityAt > 0 ? Date.now() - lastTurnActivityAt : Infinity;
    const withinCeiling = Date.now() - turnStartedAt < MAX_GATEWAY_TURN_MS;
    if (sinceProgressMs < GATEWAY_LIVENESS_RECHECK_MS && withinCeiling) {
      log.info(
        { runId, sinceProgressMs, recheckMs: GATEWAY_LIVENESS_RECHECK_MS },
        "Gateway turn deadline deferred — the turn is still producing",
      );
      timeoutHandle = setTimeout(handleTurnTimeout, GATEWAY_LIVENESS_RECHECK_MS);
      return;
    }
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
    // THE CEILING IS THE BUDGET PLUS THE ALLOWANCE, NOT THE ALLOWANCE.
    // At the shipped config gateway.turnTimeoutMs and DELEGATION_WAIT_CEILING_MS are the
    // same 1,800,000, so `armedAt + DELEGATION_WAIT_CEILING_MS + grace` equalled the deadline
    // itself and extendDeadlineForDelegationWait collapsed to max(D, min(D+w, D)) === D — the
    // clock this commit exists to pause could not move by a millisecond. runtime.ts carries
    // the corrected form for the same reason.
  if (turnTimeoutMs > 0) {
    const armedAt = Date.now();
    gatewayDeadlineMs = armedAt + turnTimeoutMs + TURN_TIMEOUT_SYNTHESIS_GRACE_MS;
    gatewayDeadlineCeilingMs = resolveDelegationWaitCeilingMs(armedAt, turnTimeoutMs, TURN_TIMEOUT_SYNTHESIS_GRACE_MS);
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
        noteTurnActivity();
        sseEvent(res, { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text });
      },

      onReasoning: (text) => {
        noteTurnActivity();
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

      // DELEGATED WORK IS WHERE THE TIME GOES, AND THIS STREAM SAID NOTHING ABOUT IT.
      //
      // Every callback above reports the ORCHESTRATOR. But a build turn spends nearly all of
      // its wall clock inside one delegate_to_agent call — 25 of 31 minutes on the measured
      // runs — during which this stream emitted a heartbeat comment and nothing else. From
      // the outside a working build and a hung one looked identical, which is also why a
      // client could not make an informed decision to stop one.
      //
      // The runtime has published these events all along and rpc.ts has consumed them since
      // the dashboard was built; this path simply never subscribed. Same event, same
      // semantics — `delegated: true` and the sub-agent's name so a client can render the
      // child's thinking in its own lane rather than splicing it into the assistant's.
      onSubAgentProgress: (event) => {
        noteTurnActivity();
        if (event.kind === "reasoning" && event.reasoning) {
          sseEvent(res, {
            type: "THINKING_TEXT_MESSAGE_CONTENT",
            messageId,
            delta: event.reasoning,
            sourceAgent: event.agentName,
            delegated: true,
          });
          return;
        }
        if (event.kind === "tool_start" && event.toolName) {
          sseEvent(res, {
            type: "TOOL_CALL_STARTED",
            toolCallId: event.toolCallId ?? `${event.agentName}_${event.iteration}`,
            toolCallName: event.toolName,
            parentMessageId: messageId,
            args: event.args,
            sourceAgent: event.agentName,
            delegated: true,
          });
          return;
        }
        if (event.kind === "tool_done" && event.toolName) {
          sseEvent(res, {
            type: "TOOL_CALL_ENDED",
            toolCallId: event.toolCallId ?? `${event.agentName}_${event.iteration}`,
            toolCallName: event.toolName,
            output: event.result,
            metadata: event.metadata,
            sourceAgent: event.agentName,
            delegated: true,
          });
          return;
        }
        if (event.kind === "started" || event.kind === "completed") {
          sseEvent(res, {
            type: "SUB_AGENT_STATUS",
            runId,
            agentName: event.agentName,
            status: event.kind,
            iteration: event.iteration,
            ...(event.summary ? { summary: event.summary } : {}),
          });
        }
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
