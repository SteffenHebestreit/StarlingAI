/**
 * Federation streaming delegate endpoint — POST /api/federation/delegate/stream.
 *
 * Mirrors POST /api/federation/delegate but emits Server-Sent Events as the
 * remote sub-agent runs.  Each peer-side progress callback fires a "progress"
 * frame; when the run completes a single "completed" frame carries the final
 * output + stats.  Errors come through as "error" frames.  Auth is the same
 * HMAC JWT used by the rest of the federation surface.
 *
 * This handler is wired into the raw http.createServer path (not Hono) so
 * back-pressure is respected and clients see frames arrive incrementally —
 * the AG-UI chat-stream endpoint uses the same pattern.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfig } from "../config/loader.js";
import { verifyFederationToken, getFederationConfig } from "../federation/index.js";
import { runSubAgentWithStats, type SubAgentProgressEvent } from "../agent/sub-agent.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { withExtractedContext, withSpan } from "../observability/tracing.js";

const log = childLogger("federation:stream");

interface DelegateStreamBody {
  agentName?: unknown;
  task?: unknown;
  context?: unknown;
  originSessionId?: unknown;
  timeoutMs?: unknown;
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function sse(res: ServerResponse, payload: Record<string, unknown>): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function jsonError(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Returns true when the URL was matched + handled.  The caller short-circuits any further routing. */
export async function handleFederationDelegateStream(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method !== "POST" || url.pathname !== "/api/federation/delegate/stream") return false;

  const config = getFederationConfig();
  if (!config.enabled) {
    jsonError(res, 404, { error: "federation disabled" });
    return true;
  }

  const token = extractBearer(req.headers["authorization"] as string | undefined);
  const verified = await verifyFederationToken(token);
  if (!verified) {
    logAudit("federation_auth_failed", { route: "delegate-stream" }, { severity: "warn" });
    jsonError(res, 401, { error: "Unauthorized" });
    return true;
  }
  // A token minted for health/capabilities must not authorize code-executing
  // delegation — the `purpose` claim is otherwise decorative.
  if (verified.purpose !== "delegate") {
    logAudit("federation_auth_failed", { route: "delegate-stream", reason: "wrong-purpose", purpose: verified.purpose }, { severity: "warn" });
    jsonError(res, 403, { error: "token purpose does not permit delegation" });
    return true;
  }

  // Buffer the request body — same shape as the non-streaming endpoint. Bounded
  // by gateway.maxBodyBytes (an authenticated peer must not exhaust memory) and
  // resolved on EVERY teardown event: awaiting only "end" wedges the handler and
  // leaks req/res forever if the client resets mid-upload. Collect Buffers and
  // decode once — per-chunk toString() corrupts a multi-byte UTF-8 char split
  // across TCP chunks.
  const maxBytes = getConfig().gateway.maxBodyBytes;
  const readResult = await new Promise<{ ok: true; raw: string } | { ok: false; reason: "too_large" | "read_error" }>((resolve) => {
    const rawChunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); resolve({ ok: false, reason: "too_large" }); return; }
      rawChunks.push(chunk);
    });
    req.on("end", () => resolve({ ok: true, raw: Buffer.concat(rawChunks).toString("utf8") }));
    req.on("error", () => resolve({ ok: false, reason: "read_error" }));
    req.on("aborted", () => resolve({ ok: false, reason: "read_error" }));
  });
  if (!readResult.ok) {
    logAudit("federation_request_failed", { peer: verified.issuer, reason: readResult.reason, streaming: true }, { severity: "warn" });
    jsonError(res, readResult.reason === "too_large" ? 413 : 400, { error: readResult.reason === "too_large" ? "Request body too large" : "invalid request body" });
    return true;
  }
  const raw = readResult.raw;

  let body: DelegateStreamBody;
  try {
    body = JSON.parse(raw) as DelegateStreamBody;
  } catch {
    jsonError(res, 400, { error: "invalid JSON body" });
    return true;
  }

  const agentName = typeof body.agentName === "string" ? body.agentName.trim() : "";
  const task = typeof body.task === "string" ? body.task : "";
  const context = typeof body.context === "string" ? body.context : undefined;
  const originSessionId = typeof body.originSessionId === "string" ? body.originSessionId : undefined;
  const requestedTimeout = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : config.delegationTimeoutMs;
  const timeoutMs = Math.min(requestedTimeout, config.delegationTimeoutMs);

  if (!agentName || !task) {
    jsonError(res, 400, { error: "agentName and task are required" });
    return true;
  }

  if (config.exposeAgents.length > 0 && !config.exposeAgents.includes(agentName)) {
    logAudit("federation_delegate_denied", { peer: verified.issuer, agentName, reason: "not in exposeAgents allowlist" }, { severity: "warn" });
    jsonError(res, 403, { error: `agent '${agentName}' is not exposed via federation` });
    return true;
  }

  const subAgentCfg = getConfig().subAgents[agentName];
  if (!subAgentCfg) {
    jsonError(res, 404, { error: `unknown agent '${agentName}'` });
    return true;
  }

  // Headers chosen to match the AG-UI stream.  X-Accel-Buffering disables
  // nginx buffering so frames flush as soon as they're written.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const remoteSessionId = `fed:${verified.issuer}:${originSessionId ?? "anon"}:${Date.now()}`;
  logAudit("federation_request_received", {
    peer: verified.issuer,
    agentName,
    originSessionId: originSessionId ?? null,
    remoteSessionId,
    taskPreview: task.slice(0, 240),
    timeoutMs,
    streaming: true,
  }, { sessionId: remoteSessionId });

  const abortController = new AbortController();
  res.on("close", () => abortController.abort());

  const onProgress = (event: SubAgentProgressEvent): void => {
    sse(res, {
      type: "progress",
      agentName: event.agentName,
      kind: event.kind,
      iteration: event.iteration,
      toolName: event.toolName,
      summary: event.summary,
    });
  };

  // Extract inbound trace context so streaming spans nest under the caller.
  const inboundHeaders: Record<string, string> = {};
  for (const k of ["traceparent", "tracestate", "baggage"]) {
    const v = req.headers[k];
    if (typeof v === "string") inboundHeaders[k] = v;
  }

  try {
    const result = await withExtractedContext(inboundHeaders, () =>
      withSpan(`federation.inbound ${agentName}`, {
        "starlingai.federation.peer": verified.issuer,
        "starlingai.federation.agent": agentName,
        "starlingai.federation.streaming": true,
      }, () => runSubAgentWithStats({
        agentName,
        task,
        context,
        parentSessionId: remoteSessionId,
        workspacePath: getConfig().workspacePath,
        turnTimeoutOverrideMs: timeoutMs,
        signal: abortController.signal,
        onProgress,
      })),
    );
    logAudit("federation_request_completed", {
      peer: verified.issuer,
      agentName,
      remoteSessionId,
      terminalState: result.stats.terminalState ?? null,
      toolCount: result.stats.toolCount,
      iterations: result.stats.iterations,
      promptTokens: result.stats.usage.promptTokens,
      completionTokens: result.stats.usage.completionTokens,
      streaming: true,
    }, { sessionId: remoteSessionId });
    sse(res, {
      type: "completed",
      output: result.output,
      remoteSessionId,
      stats: {
        terminalState: result.stats.terminalState,
        iterations: result.stats.iterations,
        toolCount: result.stats.toolCount,
        toolNames: result.stats.toolNames,
        usage: result.stats.usage,
        model: result.stats.model,
      },
    });
    res.end();
  } catch (err) {
    const message = (err as Error).message;
    log.error({ err: message, agentName, remoteSessionId }, "streaming federation delegation failed");
    logAudit("federation_request_failed", { peer: verified.issuer, agentName, remoteSessionId, error: message, streaming: true }, { sessionId: remoteSessionId, severity: "error" });
    sse(res, { type: "error", error: message, remoteSessionId });
    res.end();
  }

  return true;
}
