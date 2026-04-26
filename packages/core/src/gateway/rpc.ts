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
  resolveSession,
  listSessions,
} from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { listAllScenes } from "../credentials/scenes.js";
import { createJob } from "../agent/jobs.js";
import { getJobDefinition, listAllJobs, resolveJobSteps } from "../credentials/jobs.js";
import { subscribeToAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import type { InterventionNotice } from "../agent/interventions.js";
import { computerSessionManager } from "../agent/computer-session.js";
import { subscribeToNotifications } from "../runtime/notifications.js";
import { captureComputerSessionSnapshot } from "../agent/computer-adapters/runtime.js";

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
  | "session.rewind"
  | "audit.subscribe"
  | "audit.unsubscribe"
  | "notifications.subscribe"
  | "notifications.unsubscribe"
  | "gateway.status"
  | "scenes.list"
  | "jobs.list"
  | "approval.respond"
  | "input.respond"
  | "computer.list_sessions"
  | "computer.emergency_stop"
  | "computer.heartbeat"
  | "computer.request_screenshot";

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

interface PendingInputRequest {
  resolve: (answer: string) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const TURN_TIMEOUT_SYNTHESIS_GRACE_MS = 65_000;

interface RpcConnectionCloseOptions {
  abortInFlightTurns?: boolean;
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
 *   --iter N       — override sub-agent maxIterations (0 = unlimited, else 1–50)
 *   --agent NAME   — force delegation to a specific agent
 *   --timeout N    — override turn timeout in seconds (0 = unlimited, else 10–3600)
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
    const parsedIterations = parseInt(iterMatch[1]!, 10);
    flags.maxIterationsOverride = parsedIterations === 0
      ? 200
      : Math.max(1, Math.min(50, parsedIterations));
    clean = clean.replace(/\s*--iter\s+\d+\b/, "");
  }

  const agentMatch = clean.match(/--agent\s+(\S+)/);
  if (agentMatch) {
    flags.forceAgent = agentMatch[1]!;
    clean = clean.replace(/\s*--agent\s+\S+/, "");
  }

  const timeoutMatch = clean.match(/--timeout\s+(\d+)\b/);
  if (timeoutMatch) {
    const parsedTimeoutSec = parseInt(timeoutMatch[1]!, 10);
    flags.turnTimeoutSec = parsedTimeoutSec === 0
      ? 7200
      : Math.max(10, Math.min(3600, parsedTimeoutSec));
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

function formatJobListResponse(): string {
  const jobs = listAllJobs();
  if (jobs.length === 0) {
    return "No jobs are configured. Define jobs in Settings or under workspace/jobs/*.jsonc.";
  }

  const lines = jobs.map((job) => {
    const triggerLabels = (job.triggers ?? []).map((trigger) => trigger.type).join(", ") || "manual";
    return `- ${job.name}: ${job.description} (${job.steps.length} step${job.steps.length === 1 ? "" : "s"}; triggers: ${triggerLabels})`;
  });

  return [
    "Configured jobs:",
    "",
    ...lines,
    "",
    "Run one with /job <name> or inspect one with /job help <name>.",
  ].join("\n");
}

function formatJobHelpResponse(jobName?: string): string {
  if (!jobName) {
    return [
      "Job command syntax:",
      "",
      "- /jobs",
      "- /job <name>",
      "- /job <name> key=value other=\"value with spaces\"",
      "- /job help <name>",
      "",
      "Jobs are multi-step workflows that orchestrate one or more scenes.",
    ].join("\n");
  }

  const job = getJobDefinition(jobName);
  if (!job) {
    return `Job not found: ${jobName}`;
  }

  const params = Object.entries(job.params ?? {}).map(([key, def]) =>
    `- ${key}: ${def.description ?? "no description"}${def.default !== undefined ? ` (default: ${def.default})` : ""}`,
  );
  const steps = job.steps.map((step, index) =>
    `- ${index + 1}. ${step.label ?? step.scene}: scene=${step.scene}${step.params ? ` params=${JSON.stringify(step.params)}` : ""}`,
  );
  const triggers = (job.triggers ?? []).map((trigger) =>
    trigger.type === "cron"
      ? `- cron: ${trigger.expression}${trigger.enabled === false ? " (disabled)" : ""}`
      : trigger.type === "channel"
        ? `- channel: ${trigger.channels?.join(", ") ?? "any inbound channel"} ${trigger.mode} ${JSON.stringify(trigger.pattern)}`
        : `- api${trigger.webhookKey ? ": webhook configured" : ""}`,
  );

  return [
    `Job ${job.name}`,
    "",
    job.description,
    "",
    "Params:",
    ...(params.length > 0 ? params : ["- none"]),
    "",
    "Steps:",
    ...steps,
    "",
    "Triggers:",
    ...(triggers.length > 0 ? triggers : ["- manual only"]),
  ].join("\n");
}

export class RpcConnection {
  readonly connId: string;
  private ws: WebSocket;
  private activeSessionId: string | null = null;
  private auditUnsubscribe: (() => void) | null = null;
  private notificationsUnsubscribe: (() => void) | null = null;
  private abortControllers = new Map<string, AbortController>();
  private sessionTurnRequestIds = new Map<string, string>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private pendingInputRequests = new Map<string, PendingInputRequest>();

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

      case "session.rewind": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        const historyIndex = Number(params["historyIndex"] ?? -1);
        if (!Number.isInteger(historyIndex) || historyIndex < 0) {
          throw new Error("session.rewind requires a non-negative integer historyIndex");
        }
        const session = getSessionRecord(sid);
        if (!session) throw new Error(`Session not found: ${sid}`);
        session.rewindBeforeIndex(historyIndex);
        return { rewound: true, historyIndex };
      }

      case "scenes.list":
        return listAllScenes().map(s => ({ name: s.name, description: s.description, source: s.source }));

      case "jobs.list":
        return listAllJobs().map((job) => ({ name: job.name, description: job.description, source: job.source }));

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

      case "input.respond": {
        const inputId = String(params["inputId"] ?? "");
        const answer = String(params["answer"] ?? "");
        const pendingInput = this.pendingInputRequests.get(inputId);
        if (pendingInput) {
          clearTimeout(pendingInput.timeout);
          this.pendingInputRequests.delete(inputId);
          pendingInput.resolve(answer);
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
        const effectiveTurnTimeoutMs = overrideFlags.turnTimeoutSec !== undefined
          ? overrideFlags.turnTimeoutSec * 1000
          : turnTimeoutMs;

        if (!message.trim()) {
          this.sendEvent({
            type: "status",
            data: {
              status: "blocked",
              requestId,
              response: "Please include an instruction in addition to override flags.",
            },
          });
          return { accepted: false, requestId };
        }

        if (/^\/jobs\s*$/i.test(message)) {
          this.sendEvent({ type: "status", data: { status: "accepted", requestId, info: "Listing jobs" } });
          this.sendEvent({
            type: "status",
            data: {
              status: "ok",
              requestId,
              response: formatJobListResponse(),
              toolCallsExecuted: 0,
              guardrailEvents: [],
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            },
          });
          return { accepted: true, requestId };
        }

        const jobHelpMatch = message.match(/^\/job\s+help(?:\s+(\S+))?\s*$/i);
        if (jobHelpMatch) {
          this.sendEvent({ type: "status", data: { status: "accepted", requestId, info: "Showing job help" } });
          this.sendEvent({
            type: "status",
            data: {
              status: "ok",
              requestId,
              response: formatJobHelpResponse(jobHelpMatch[1]),
              toolCallsExecuted: 0,
              guardrailEvents: [],
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            },
          });
          return { accepted: true, requestId };
        }

        // Handle /run <sceneName> [key=value ...] — substitute scene task with params
        let sceneAllowedAgents: string[] | undefined;
        let humanInLoopSteps: string[] | undefined;

        const jobMatch = message.match(/^\/job\s+(\S+)(?:\s+(.*))?$/s);
        if (jobMatch) {
          const jobName = jobMatch[1]!;
          const job = getJobDefinition(jobName);
          if (!job) {
            this.sendEvent({ type: "status", data: { status: "error", requestId, error: `Job not found: ${jobName}` } });
            return { accepted: false, requestId };
          }

          try {
            const params = parseKeyValuePairs(jobMatch[2] ?? "");
            const steps = resolveJobSteps(job, params);
            const queued = await createJob({
              sceneName: jobName,
              definitionType: "job",
              userId: `job:${jobName}`,
              steps,
              turnTimeoutMs: effectiveTurnTimeoutMs,
            });
            this.sendEvent({ type: "status", data: { status: "accepted", requestId, info: `Queued job: ${jobName}` } });
            this.sendEvent({
              type: "status",
              data: {
                status: "ok",
                requestId,
                response: `Queued job ${jobName} as ${queued.id}. Track progress in the Jobs panel.`,
                toolCallsExecuted: 0,
                guardrailEvents: [],
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              },
            });
            return { accepted: true, queued: true, requestId, jobId: queued.id };
          } catch (err) {
            this.sendEvent({ type: "status", data: { status: "error", requestId, error: err instanceof Error ? err.message : String(err) } });
            return { accepted: false, requestId };
          }
        }

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
        const session = getSession(sessionId) ?? await resolveSession(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);

        const supersededRequestId = this.sessionTurnRequestIds.get(session.id);
        if (supersededRequestId && supersededRequestId !== requestId) {
          this.abortControllers.get(supersededRequestId)?.abort();
        }

        const ac = new AbortController();
        this.abortControllers.set(requestId, ac);
        this.sessionTurnRequestIds.set(session.id, requestId);

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let timedOut = false;
        let completed = false;

        const cleanupTurn = () => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          this.abortControllers.delete(requestId);
          if (this.sessionTurnRequestIds.get(session.id) === requestId) {
            this.sessionTurnRequestIds.delete(session.id);
          }
        };

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
              error: `Turn exceeded the timeout window and did not finish synthesis. Session archived.`,
            },
          });
        };

        if (effectiveTurnTimeoutMs > 0) {
          timeoutHandle = setTimeout(endTimedOutSession, effectiveTurnTimeoutMs + TURN_TIMEOUT_SYNTHESIS_GRACE_MS);
        }

        if (
          overrideFlags.autoApprove
          || overrideFlags.maxIterationsOverride !== undefined
          || overrideFlags.forceAgent
          || overrideFlags.turnTimeoutSec !== undefined
        ) {
          const flagSummary = [
            overrideFlags.autoApprove ? "auto-approve" : null,
            overrideFlags.maxIterationsOverride !== undefined ? `iter=${overrideFlags.maxIterationsOverride}` : null,
            overrideFlags.forceAgent ? `agent=${overrideFlags.forceAgent}` : null,
            overrideFlags.turnTimeoutSec !== undefined ? `timeout=${overrideFlags.turnTimeoutSec}s` : null,
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
          onToolCall: (toolCallId, name, args) => {
            this.sendEvent({ type: "agent.tool_start", data: { requestId, toolCallId, name, args } });
          },
          onToolResult: (toolCallId, name, result, metadata) => {
            this.sendEvent({
              type: "agent.tool_done",
              data: {
                requestId,
                toolCallId,
                name,
                result: result.substring(0, 500),
                metadata,
              },
            });
          },
          onSubAgentProgress: (event) => {
            if (event.kind === "tool_start" && event.toolName) {
              this.sendEvent({
                type: "agent.tool_start",
                data: {
                  requestId,
                  toolCallId: event.toolCallId ?? `${event.agentName}:${event.toolName}:${event.iteration}`,
                  name: event.toolName,
                  args: event.args ?? {},
                  sourceAgent: event.agentName,
                  delegated: true,
                },
              });
              return;
            }

            if (event.kind === "tool_done" && event.toolName) {
              this.sendEvent({
                type: "agent.tool_done",
                data: {
                  requestId,
                  toolCallId: event.toolCallId ?? `${event.agentName}:${event.toolName}:${event.iteration}`,
                  name: event.toolName,
                  result: String(event.result ?? "").substring(0, 500),
                  metadata: event.metadata,
                  sourceAgent: event.agentName,
                  delegated: true,
                },
              });
            }
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
          inputCallback: async (question, choices, timeoutMs = 120_000) => {
            const inputId = randomUUID();
            this.sendEvent({ type: "agent.input_needed", data: { requestId, inputId, question, choices } });

            return new Promise<string>((resolve) => {
              const timeout = setTimeout(() => {
                this.pendingInputRequests.delete(inputId);
                log.warn({ inputId }, "User input timed out — returning empty string");
                resolve("");
              }, timeoutMs);
              this.pendingInputRequests.set(inputId, { resolve, timeout });
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

      case "notifications.subscribe": {
        this.notificationsUnsubscribe?.();
        this.notificationsUnsubscribe = subscribeToNotifications((notification) => {
          this.sendEvent({ type: "notification.event", data: notification });
        });
        return { subscribed: true };
      }

      case "notifications.unsubscribe":
        this.notificationsUnsubscribe?.();
        this.notificationsUnsubscribe = null;
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

      case "computer.request_screenshot": {
        const csId = String(params["computerSessionId"] ?? "");
        const session = computerSessionManager.getSession(csId);
        if (!session || session.state !== "active") {
          return { ok: false, error: `No active session: ${csId}` };
        }
        try {
          const snapshot = await captureComputerSessionSnapshot(csId);
          if (snapshot.dataUrl && typeof snapshot.width === "number" && typeof snapshot.height === "number") {
            this.sendEvent({
              type: "computer.screenshot",
              data: {
                computerSessionId: csId,
                dataUrl: snapshot.dataUrl,
                width: snapshot.width,
                height: snapshot.height,
                timestamp: snapshot.timestamp,
                frameId: snapshot.frameId,
                activeWindow: snapshot.activeWindow,
                displayTopology: session.displayTopology,
              },
            });
          }
        } catch (err) {
          log.debug({ csId, err }, "computer.request_screenshot capture failed (non-fatal)");
        }
        return { ok: true };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  close(options: RpcConnectionCloseOptions = {}): void {
    const shouldAbortInFlightTurns = options.abortInFlightTurns === true;
    this.auditUnsubscribe?.();
    this.notificationsUnsubscribe?.();
    for (const [id, controller] of this.abortControllers) {
      if (shouldAbortInFlightTurns) {
        controller.abort();
        log.info({ connId: this.connId, turnId: id }, "Aborted in-flight turn on connection close");
      } else {
        log.info({ connId: this.connId, turnId: id }, "Preserved in-flight turn after connection close to allow session recovery");
      }
    }
    this.abortControllers.clear();
    // Reject any pending approvals so tool calls unblock immediately
    for (const [, pending] of this.pendingApprovals) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingApprovals.clear();
    // Resolve any pending input requests with empty string so they unblock
    for (const [, pending] of this.pendingInputRequests) {
      clearTimeout(pending.timeout);
      pending.resolve("");
    }
    this.pendingInputRequests.clear();
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
