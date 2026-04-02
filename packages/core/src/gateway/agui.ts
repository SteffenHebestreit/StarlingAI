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
import { archiveSession, getSession, createSession } from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import type { InterventionNotice } from "../agent/interventions.js";

const log = childLogger("gateway:agui");

// ─── Event helpers ────────────────────────────────────────────────────────────

function sseEvent(res: ServerResponse, event: Record<string, unknown>): void {
  const data = JSON.stringify(event);
  res.write(`data: ${data}\n\n`);
}

// ─── Main handler — called from gateway/index.ts ──────────────────────────────

export async function handleAguiStream(
  res: ServerResponse,
  body: { sessionId?: string; message: string },
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

  // Get or create session
  let session = sessionId ? getSession(sessionId) : undefined;
  if (!session) {
    session = createSession({ channel: "webchat:agui" });
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
    if (timedOut) return;
    timedOut = true;
    abortController.abort();
    archiveSession(session.id);
    sseEvent(res, {
      type: "RUN_ERROR",
      runId,
      message: `Turn timed out after ${Math.round(turnTimeoutMs / 60000)} minutes. Session archived.`,
    });
  };

  // Handle client disconnect
  res.on("close", () => {
    cleanupTimeout();
    abortController.abort();
    log.debug({ runId }, "AG-UI client disconnected");
  });

  timeoutHandle = setTimeout(handleTurnTimeout, turnTimeoutMs);

  try {
    let textStarted = false;

    await runTurn({
      session,
      userMessage: message,
      signal: abortController.signal,

      onChunk: (text) => {
        if (!textStarted) {
          sseEvent(res, { type: "TEXT_MESSAGE_STARTED", messageId, role: "assistant" });
          textStarted = true;
        }
        sseEvent(res, { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text });
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
