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
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import type { InterventionNotice } from "../agent/interventions.js";

const TURN_TIMEOUT_SYNTHESIS_GRACE_MS = 65_000;

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
  userId?: string,
): Promise<void> {
  const { message, sessionId } = body;

  if (!message?.trim()) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "message is required" }));
    return;
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

  // Get or create session — try Redis fallback for cross-instance routing.
  // Create it UNDER the requested id (so session-scoped documents uploaded with
  // that sessionId are in retrieval scope) and attribute it to the authenticated
  // user (so the document-RAG user scope + RBAC match the identity uploads use),
  // mirroring the RPC session.create path. Without both, AG-UI turns ran under a
  // fresh random session with no userId, dropping session/user document scope.
  let session = sessionId ? await resolveSession(sessionId) : undefined;
  if (!session) {
    session = createSession({
      ...(sessionId ? { sessionId } : {}),
      channel: "webchat:agui",
      ...(userId ? { userId } : {}),
    });
  }

  const turnTimeoutMs = getConfig().gateway.turnTimeoutMs;

  sseEvent(res, { type: "RUN_STARTED", runId, threadId: session.id });

  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const cleanupTimeout = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  };

  const handleTurnTimeout = () => {
    if (timedOut || res.writableEnded) return; // already handled / stream already closed
    timedOut = true;
    abortController.abort();
    archiveSession(session.id);
    sseEvent(res, {
      type: "RUN_ERROR",
      runId,
      message: "Turn exceeded the timeout window and did not finish synthesis. Session archived.",
    });
  };

  // Handle client disconnect
  res.on("close", () => {
    cleanupTimeout();
    abortController.abort();
    log.debug({ runId }, "AG-UI client disconnected");
  });

  // A SINGLE turn-timeout timer (+GRACE for synthesis), armed after the close
  // handler so disconnect cleanup is wired first. A second timer here previously
  // overwrote the handle and orphaned the first, which then fired after a normal
  // completion — spuriously archiving the session and writing to a closed stream.
  timeoutHandle = setTimeout(handleTurnTimeout, turnTimeoutMs + TURN_TIMEOUT_SYNTHESIS_GRACE_MS);

  try {
    let textStarted = false;
    let streamedMeaningfulText = false;

    const turnResult = await runTurn({
      session,
      userMessage: message,
      signal: abortController.signal,

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

    cleanupTimeout();
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
    cleanupTimeout();
    if (timedOut) return;
    if (!abortController.signal.aborted) {
      log.error({ err, runId }, "AG-UI run error");
      sseEvent(res, { type: "RUN_ERROR", runId, message: String(err) });
    }
  } finally {
    cleanupTimeout();
    res.end();
  }
}
