/**
 * WebSocket RPC protocol handler.
 * Protocol: connect → hello-ok → req/res pairs + event streams
 */
import type WebSocket from "ws";
import { randomUUID } from "node:crypto";
import {
  archiveSession,
  createSession,
  deleteSession,
  getSession,
  getSessionRecord,
  getSessionTranscript,
  listSessions,
} from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { listAllScenes } from "../credentials/scenes.js";
import { subscribeToAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import type { InterventionNotice } from "../agent/interventions.js";
import { computerSessionManager } from "../agent/computer-session.js";

const log = childLogger("gateway:rpc");

export type RpcMethod =
  | "chat.send"
  | "chat.cancel"
  | "session.create"
  | "session.end"
  | "session.get"
  | "session.list"
  | "session.archive"
  | "session.delete"
  | "session.reset"
  | "audit.subscribe"
  | "audit.unsubscribe"
  | "gateway.status"
  | "scenes.list"
  | "approval.respond"
  | "computer.list_sessions"
  | "computer.emergency_stop"
  | "computer.heartbeat";

interface RpcRequest {
  id: string;
  method: RpcMethod;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

interface GatewayEvent {
  type: string;
  data: unknown;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Substitute {{key}} or {{key|default}} placeholders in a task string.
 * Values come from `params`; missing keys fall back to their declared default,
 * or are left as-is if no default is given.
 */
function applyParamTemplate(task: string, params: Record<string, string>): string {
  return task.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (match, key: string, defaultVal?: string) => {
    if (key in params) return params[key]!;
    if (defaultVal !== undefined) return defaultVal;
    return match;
  });
}

interface OverrideFlags {
  autoApprove: boolean;
  maxIterationsOverride?: number;
  forceAgent?: string;
  turnTimeoutSec?: number;
}

/**
 * Parse inline override flags from a message string.
 * Supported flags:
 *   --auto         — auto-approve all tool calls this turn
 *   --iter N       — override sub-agent maxIterations (1–50)
 *   --agent NAME   — force delegation to a specific agent
 *   --timeout N    — override turn timeout in seconds (10–3600)
 * Returns the cleaned message (flags stripped) and the parsed flags.
 */
function parseOverrideFlags(message: string): { clean: string; flags: OverrideFlags } {
  let clean = message;
  const flags: OverrideFlags = { autoApprove: false };

  if (/--auto\b/.test(clean)) {
    flags.autoApprove = true;
    clean = clean.replace(/\s*--auto\b/g, "");
  }

  const iterMatch = clean.match(/--iter\s+(\d+)\b/);
  if (iterMatch) {
    flags.maxIterationsOverride = Math.max(1, Math.min(50, parseInt(iterMatch[1]!, 10)));
    clean = clean.replace(/\s*--iter\s+\d+\b/, "");
  }

  const agentMatch = clean.match(/--agent\s+(\S+)/);
  if (agentMatch) {
    flags.forceAgent = agentMatch[1]!;
    clean = clean.replace(/\s*--agent\s+\S+/, "");
  }

  const timeoutMatch = clean.match(/--timeout\s+(\d+)\b/);
  if (timeoutMatch) {
    flags.turnTimeoutSec = Math.max(10, Math.min(3600, parseInt(timeoutMatch[1]!, 10)));
    clean = clean.replace(/\s*--timeout\s+\d+\b/, "");
  }

  return { clean: clean.trim(), flags };
}

/**
 * Parse `key=value` pairs from a raw string (tail of `/run sceneName k=v k2="v 2"`).
 * Supports double-quoted values for strings containing spaces.
 */
function parseKeyValuePairs(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const m of raw.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
    params[m[1]!] = (m[2] ?? "").replace(/^"|"$/g, "").replace(/\\"/g, '"');
  }
  return params;
}

export class RpcConnection {
  readonly connId: string;
  private ws: WebSocket;
  private activeSessionId: string | null = null;
  private auditUnsubscribe: (() => void) | null = null;
  private abortControllers = new Map<string, AbortController>();
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(ws: WebSocket) {
    this.connId = randomUUID();
    this.ws = ws;
    this.sendEvent({ type: "hello-ok", data: {
      connId: this.connId,
      version: "0.1.0",
      sessions: listSessions({ includeArchived: true }),
    }});
    log.info({ connId: this.connId }, "RPC connection established");
  }

  async handleMessage(raw: string): Promise<void> {
    let req: RpcRequest;
    try {
      req = JSON.parse(raw) as RpcRequest;
    } catch {
      this.sendRaw({ type: "error", data: "Invalid JSON" });
      return;
    }

    const { id, method, params } = req;
    log.debug({ connId: this.connId, method, id }, "RPC request");

    try {
      const payload = await this.dispatch(method, params ?? {});
      this.sendResponse({ id, ok: true, payload });
    } catch (err) {
      log.error({ err, method, connId: this.connId }, "RPC error");
      this.sendResponse({ id, ok: false, error: String(err) });
    }
  }

  private async dispatch(method: RpcMethod, params: Record<string, unknown>): Promise<unknown> {
    const turnTimeoutMs = getConfig().gateway.turnTimeoutMs;

    switch (method) {
      case "gateway.status":
        return { status: "running", sessions: listSessions().length, uptime: process.uptime() };

      case "session.create": {
        let workspacePath: string | undefined = undefined;
        // In local/dev contexts, we allow setting a workspace path.
        // In a real deployed environment, this should be overridden or constrained by the gateway.
        if (params["workspacePath"]) {
          const requestedPath = String(params["workspacePath"]);
          // SECURITY: Only allow relative paths inside a safe workspace root, never absolute host paths like "/"
          if (requestedPath.startsWith("/") || requestedPath.includes("..")) {
             log.warn({ requestedPath, connId: this.connId }, "Rejected relative or absolute workspacePath override");
             throw new Error("Invalid workspacePath: must be a relative path without traversal");
          }
          workspacePath = requestedPath;
        }

        const session = createSession({
          channel: String(params["channel"] ?? "webchat"),
          userId: params["userId"] ? String(params["userId"]) : undefined,
          workspacePath,
        });
        this.activeSessionId = session.id;
        return { sessionId: session.id };
      }

      case "session.end": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        archiveSession(sid);
        if (this.activeSessionId === sid) this.activeSessionId = null;
        return { ended: true };
      }

      case "session.archive": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        const archived = archiveSession(sid);
        if (this.activeSessionId === sid) this.activeSessionId = null;
        return { archived, sessionId: sid };
      }

      case "session.delete": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        const deleted = deleteSession(sid);
        if (this.activeSessionId === sid) this.activeSessionId = null;
        return { deleted, sessionId: sid };
      }

      case "session.get": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        const limitRaw = params["limit"];
        const beforeMessageId = typeof params["beforeMessageId"] === "string" && params["beforeMessageId"].trim()
          ? String(params["beforeMessageId"])
          : undefined;
        const limit = typeof limitRaw === "number"
          ? limitRaw
          : typeof limitRaw === "string" && limitRaw.trim()
            ? Number.parseInt(limitRaw, 10)
            : undefined;
        const transcript = getSessionTranscript(sid, { limit, beforeMessageId });
        if (!transcript) throw new Error(`Session not found: ${sid}`);
        return transcript;
      }

      case "session.list":
        return listSessions({ includeArchived: true });

      case "session.reset": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        getSessionRecord(sid)?.reset();
        return { reset: true };
      }

      case "scenes.list":
        return listAllScenes().map(s => ({ name: s.name, description: s.description, source: s.source }));

      case "approval.respond": {
        const approvalId = String(params["approvalId"] ?? "");
        const approved = Boolean(params["approved"]);
        const pending = this.pendingApprovals.get(approvalId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingApprovals.delete(approvalId);
          pending.resolve(approved);
        }
        return { ok: true };
      }

      case "chat.send": {
        const sessionId = String(params["sessionId"] ?? this.activeSessionId ?? "");
        let message = String(params["message"] ?? "");
        const requestId = String(params["requestId"] ?? randomUUID());
        const enableThinkingRaw = params["enableThinking"];
        const enableThinking: boolean | undefined =
          enableThinkingRaw === true || enableThinkingRaw === "true" ? true :
          enableThinkingRaw === false || enableThinkingRaw === "false" ? false :
          undefined;

        // Parse inline override flags (--auto, --iter N, --agent NAME) before scene handling
        const { clean: cleanMessage, flags: overrideFlags } = parseOverrideFlags(message);
        message = cleanMessage;

        // Handle /run <sceneName> [key=value ...] — substitute scene task with params
        let sceneAllowedAgents: string[] | undefined;
        let humanInLoopSteps: string[] | undefined;

        const runMatch = message.match(/^\/run\s+(\S+)(?:\s+(.*))?$/s);
        if (runMatch) {
          const sceneName = runMatch[1]!;
          const scene = listAllScenes().find(s => s.name === sceneName);
          if (!scene) {
            this.sendEvent({ type: "status", data: { status: "error", requestId, error: `Scene not found: ${sceneName}` } });
            return { accepted: false, requestId };
          }

          // Parse inline key=value params and merge over scene-declared defaults
          const inlineParams = parseKeyValuePairs(runMatch[2] ?? "");
          const mergedParams: Record<string, string> = {};
          for (const [key, def] of Object.entries(scene.params ?? {})) {
            if (def.default !== undefined) mergedParams[key] = def.default;
          }
          Object.assign(mergedParams, inlineParams);

          message = applyParamTemplate(scene.task, mergedParams);
          sceneAllowedAgents = scene.allowedAgents;
          humanInLoopSteps = scene.humanInLoopSteps;

          this.sendEvent({ type: "status", data: { status: "accepted", requestId, info: `Running scene: ${sceneName}` } });
        } else {
          const activeFlagsPayload = {
            ...(overrideFlags.autoApprove ? { autoApprove: true } : {}),
            ...(overrideFlags.maxIterationsOverride !== undefined ? { maxIterations: overrideFlags.maxIterationsOverride } : {}),
            ...(overrideFlags.forceAgent ? { agent: overrideFlags.forceAgent } : {}),
            ...(overrideFlags.turnTimeoutSec !== undefined ? { timeout: overrideFlags.turnTimeoutSec } : {}),
          };
          this.sendEvent({ type: "status", data: { status: "accepted", requestId, ...(Object.keys(activeFlagsPayload).length ? { activeFlags: activeFlagsPayload } : {}) } });
        }

        if (!sessionId) throw new Error("No active session — call session.create first");
        const session = getSession(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);

        const ac = new AbortController();
        this.abortControllers.set(requestId, ac);

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let timedOut = false;
        let completed = false;

        const cleanupTurn = () => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          this.abortControllers.delete(requestId);
        };

        // Apply --timeout override to both the inner runTurn and the outer watchdog
        const effectiveTurnTimeoutMs = overrideFlags.turnTimeoutSec !== undefined
          ? overrideFlags.turnTimeoutSec * 1000
          : turnTimeoutMs;

        // --agent flag overrides sceneAllowedAgents (narrows to a single agent)
        const effectiveAllowedAgents = overrideFlags.forceAgent
          ? [overrideFlags.forceAgent]
          : sceneAllowedAgents;

        const endTimedOutSession = () => {
          if (timedOut || completed) return;
          timedOut = true;
          ac.abort();
          cleanupTurn();
          if (this.activeSessionId === session.id) this.activeSessionId = null;
          archiveSession(session.id);
          this.sendEvent({
            type: "status",
            data: {
              status: "error",
              requestId,
              error: `Turn timed out after ${Math.round(effectiveTurnTimeoutMs / 60000)} minutes. Session archived.`,
            },
          });
        };

        timeoutHandle = setTimeout(endTimedOutSession, effectiveTurnTimeoutMs);

        if (overrideFlags.autoApprove || overrideFlags.maxIterationsOverride || overrideFlags.forceAgent || overrideFlags.turnTimeoutSec) {
          const flagSummary = [
            overrideFlags.autoApprove ? "auto-approve" : null,
            overrideFlags.maxIterationsOverride ? `iter=${overrideFlags.maxIterationsOverride}` : null,
            overrideFlags.forceAgent ? `agent=${overrideFlags.forceAgent}` : null,
            overrideFlags.turnTimeoutSec ? `timeout=${overrideFlags.turnTimeoutSec}s` : null,
          ].filter(Boolean).join(", ");
          log.info({ requestId, flags: flagSummary }, "Inline overrides active");
        }

        runTurn({
          session,
          userMessage: message,
          signal: ac.signal,
          allowedAgents: effectiveAllowedAgents,
          humanInLoopSteps,
          autoApprove: overrideFlags.autoApprove,
          maxIterationsOverride: overrideFlags.maxIterationsOverride,
          turnTimeoutOverrideMs: overrideFlags.turnTimeoutSec !== undefined ? overrideFlags.turnTimeoutSec * 1000 : undefined,
          enableThinking,
          onChunk: (text) => {
            this.sendEvent({ type: "agent.chunk", data: { requestId, text } });
          },
          onToolCall: (name, args) => {
            this.sendEvent({ type: "agent.tool_start", data: { requestId, name, args } });
          },
          onToolResult: (name, result, metadata) => {
            this.sendEvent({
              type: "agent.tool_done",
              data: {
                requestId,
                name,
                result: result.substring(0, 500),
                metadata,
              },
            });
          },
          onIntervention: (notice: InterventionNotice) => {
            this.sendEvent({ type: "agent.intervention", data: { requestId, notice } });
          },
          onSwarmState: (swarmState) => {
            this.sendEvent({ type: "agent.swarm", data: { requestId, swarmState } });
          },
          onComputerAction: (action: { computerSessionId: string; actionType: string; [k: string]: unknown }) => {
            this.sendEvent({ type: "computer.action", data: { requestId, ...action } });
          },
          onComputerScreenshot: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => {
            this.sendEvent({ type: "computer.screenshot", data: { requestId, ...screenshot } });
          },
          onComputerSessionState: (sessionState: { computerSessionId: string; state: string }) => {
            this.sendEvent({ type: "computer.session_state", data: { requestId, ...sessionState } });
          },
          approvalCallback: async (toolName, args) => {
            const approvalId = randomUUID();
            this.sendEvent({ type: "agent.approval_needed", data: { requestId, toolName, args, approvalId } });

            return new Promise<boolean>((resolve) => {
              // Auto-deny after 60 s if the user does not respond
              const timeout = setTimeout(() => {
                this.pendingApprovals.delete(approvalId);
                log.warn({ approvalId, toolName }, "Approval timed out — denying");
                resolve(false);
              }, 60_000);
              this.pendingApprovals.set(approvalId, { resolve, timeout });
            });
          },
        }).then(output => {
          if (timedOut || completed) return;
          completed = true;
          cleanupTurn();
          this.sendEvent({
            type: "status",
            data: {
              status: output.blocked ? "blocked" : "ok",
              requestId,
              response: output.response,
              toolCallsExecuted: output.toolCallsExecuted,
              guardrailEvents: output.guardrailEvents,
              usage: output.usage,
              swarmState: output.swarmState,
              performance: output.performance,
            },
          });
        }).catch(err => {
          if (timedOut || completed) return;
          completed = true;
          cleanupTurn();
          this.sendEvent({ type: "status", data: { status: "error", requestId, error: String(err) } });
        });

        return { accepted: true, requestId };
      }

      case "chat.cancel": {
        const requestId = String(params["requestId"] ?? "");
        const ac = this.abortControllers.get(requestId);
        if (ac) {
          ac.abort();
          this.abortControllers.delete(requestId);
        }
        return { cancelled: Boolean(ac), requestId };
      }

      case "audit.subscribe": {
        if (this.auditUnsubscribe) this.auditUnsubscribe();
        this.auditUnsubscribe = subscribeToAudit(event => {
          this.sendEvent({ type: "audit.event", data: event });
        });
        return { subscribed: true };
      }

      case "audit.unsubscribe":
        this.auditUnsubscribe?.();
        this.auditUnsubscribe = null;
        return { unsubscribed: true };

      // ── Computer-use session RPC ───────────────────────────────────────
      case "computer.list_sessions":
        return { sessions: computerSessionManager.listSessions() };

      case "computer.emergency_stop": {
        const csId = String(params["computerSessionId"] ?? "");
        const reason = String(params["reason"] ?? "rpc:manual_stop");
        computerSessionManager.emergencyStop(csId, reason);
        return { ok: true };
      }

      case "computer.heartbeat": {
        const csId = String(params["computerSessionId"] ?? "");
        computerSessionManager.heartbeat(csId);
        return { ok: true };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  close(): void {
    this.auditUnsubscribe?.();
    for (const ac of this.abortControllers.values()) ac.abort();
    // Reject any pending approvals so tool calls unblock immediately
    for (const [, pending] of this.pendingApprovals) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingApprovals.clear();
    log.info({ connId: this.connId }, "RPC connection closed");
  }

  private sendEvent(event: GatewayEvent): void {
    this.sendRaw({ ...event });
  }

  private sendResponse(res: RpcResponse): void {
    this.sendRaw({ type: "rpc.response", ...res });
  }

  private sendRaw(data: unknown): void {
    if (this.ws.readyState === 1 /* OPEN */) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch (err) {
        log.error({ err }, "Failed to send WS message");
      }
    }
  }
}
