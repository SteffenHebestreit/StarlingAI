/**
 * WebSocket RPC protocol handler.
 * Protocol: connect → hello-ok → req/res pairs + event streams
 */
import type WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { subAgentProgressStatus } from "./sub-agent-progress-status.js";
import {
  archiveSession,
  createSession,
  deleteSession,
  describeMissingSession,
  getSession,
  getSessionRecord,
  getSessionTranscript,
  resolveSession,
  listSessions,
} from "../agent/session.js";
import type { SessionTranscriptAttachment, SessionTranscriptMessage, SessionSummary } from "../agent/session.js";
import { normalizeRole, roleRank } from "./auth.js";
import { callerMayUseSession } from "./session-route-access.js";
import type { AuditEvent } from "../audit/schema.js";
import { runTurn, buildTimeoutDeliveryMessage } from "../agent/runtime.js";
import { extendDeadlineForDelegationWait, resolveDelegationWaitCeilingMs } from "../agent/delegation-budget.js";
import { resolveEffortProfile, resolveEffortTier } from "../runtime/effort-context.js";
import type { EffortTier } from "../config/schema.js";
import { listAllScenes } from "../credentials/scenes.js";
import { createJob } from "../agent/jobs.js";
import { getJobDefinition, listAllJobs, resolveJobSteps } from "../credentials/jobs.js";
import { subscribeToAudit, logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import type { InterventionNotice } from "../agent/interventions.js";
import { computerSessionManager } from "../agent/computer-session.js";
import { subscribeToNotifications } from "../runtime/notifications.js";
import { captureComputerSessionSnapshot } from "../agent/computer-adapters/runtime.js";
import { resolveSessionWorkspaceOverride } from "./session-workspace.js";
import { longRunningGenerationManager } from "../agent/long-running-generation.js";
import { turnSteeringManager, unconsumedSteeringOf, type SteeringMessage } from "../agent/turn-steering.js";
import { HUMAN_WAIT_RECHECK_MS, trackHumanWaits, userInputBroker, type UserInputCaller } from "../agent/user-input-broker.js";
import { clampUserInputTimeoutMs } from "../agent/user-input.js";
import { typedUserWords } from "../agent/delegation-user-words.js";
import { currentRequestContext, runWithRequestContext } from "../runtime/request-context.js";

/**
 * How often the gateway turn watchdog re-checks a turn it has suspended for an operator
 * unbounded grant. Re-arming rather than cancelling means the watchdog comes back if the
 * grant is ever cleared, so a grant cannot silently disarm the turn deadline forever.
 */
const GRANTED_TURN_RECHECK_MS = 60_000;
/** How long a quiet turn may sit before the gateway watchdog stops deferring to it. */
const TURN_LIVENESS_RECHECK_MS = 300_000;
/** Absolute ceiling, so a turn that chatters without finishing cannot defer forever. */
const MAX_GATEWAY_TURN_MS = 86_400_000;

const log = childLogger("gateway:rpc");

/**
 * Every chat turn this process is running, by request id, whichever connection started it — and
 * the newest one of each session. A connection's own maps die with its socket while its turns run
 * on (close() keeps them for recovery), so a reloaded page or a second tab could not stop the turn,
 * could not tell which turn was running, and its next message started a second turn beside the
 * first on one history (review #2, #7, #15, #38).
 */
interface LiveChatTurn {
  requestId: string;
  sessionId: string;
  startedAt: number;
  /** Aborted once the turn is stopped, superseded or timed out; it may still be unwinding. */
  signal: AbortSignal;
  /** Stop it as chat.cancel on its own connection does; false when it was already stopped. */
  abort: () => boolean;
}
const liveChatTurns = new Map<string, LiveChatTurn>();
const liveChatTurnBySession = new Map<string, string>();

/**
 * Turns that ended here lately, by request id, so a Stop that arrives just after can say "that turn
 * is over" rather than "no such turn". The web stops a turn it followed after a reload by its session
 * when chat.cancel does not know it; told nothing more than `cancelled: false`, it also did that for
 * a turn that had just finished, and the session route stopped the turn that had replaced it (review
 * of round 1, B #3).
 */
const ENDED_TURN_MEMORY_MS = 10 * 60_000;
const MAX_ENDED_TURNS = 1_000;
const endedChatTurns = new Map<string, { sessionId: string; endedAt: number }>();

function rememberEndedChatTurn(requestId: string, sessionId: string): void {
  const now = Date.now();
  for (const [id, ended] of endedChatTurns) {
    if (now - ended.endedAt <= ENDED_TURN_MEMORY_MS && endedChatTurns.size < MAX_ENDED_TURNS) break;
    endedChatTurns.delete(id);
  }
  endedChatTurns.delete(requestId);
  endedChatTurns.set(requestId, { sessionId, endedAt: now });
}

/** The session of a turn that is running here or ended here lately. */
function knownChatTurnSession(requestId: string): string | undefined {
  const live = liveChatTurns.get(requestId);
  if (live) return live.sessionId;
  const ended = endedChatTurns.get(requestId);
  return ended && Date.now() - ended.endedAt <= ENDED_TURN_MEMORY_MS ? ended.sessionId : undefined;
}

/** The session's running turn; one already stopped and still unwinding does not count. */
function liveChatTurnOf(sessionId: string): LiveChatTurn | undefined {
  const requestId = liveChatTurnBySession.get(sessionId);
  const turn = requestId ? liveChatTurns.get(requestId) : undefined;
  return turn && !turn.signal.aborted ? turn : undefined;
}

/** The chat a nested session id belongs to: `sub:<parent>:<agent>:<ts>` and
 *  `workflow:<parent>:<name>:<uuid>` embed their parent, at any depth. */
function owningChatSessionId(sessionId: string): string {
  let current = sessionId;
  for (;;) {
    const prefix = ["sub:", "workflow:"].find((candidate) => current.startsWith(candidate));
    if (!prefix) return current;
    const inner = current.slice(prefix.length);
    const lastColon = inner.lastIndexOf(":");
    const secondLastColon = lastColon > 0 ? inner.lastIndexOf(":", lastColon - 1) : -1;
    if (secondLastColon <= 0) return inner;
    current = inner.slice(0, secondLastColon);
  }
}

/**
 * The text the transcript will show for the part of the turn before a steering cut: the merged
 * assistant entry just ahead of the messages that cut it, or "" when that part wrote none. The
 * client used to take it from its own stream buffer, which holds only an unvalidated iteration-0
 * draft — often empty while the saved part has text, sometimes a draft a guard threw away that no
 * reload shows (review #9).
 */
function steeringSegmentText(transcript: readonly SessionTranscriptMessage[], consumedIds: ReadonlySet<string>): string {
  let index = transcript.length - 1;
  while (index >= 0 && transcript[index]!.midTurn && consumedIds.has(transcript[index]!.steeringId ?? "")) index -= 1;
  const before = transcript[index];
  return before?.role === "assistant" ? before.content : "";
}

function formatApprovalTimeout(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) return `${timeoutMs / 60_000} min`;
  return `${Math.round(timeoutMs / 1000)} s`;
}

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
  | "session.updateSettings"
  | "audit.subscribe"
  | "audit.unsubscribe"
  | "notifications.subscribe"
  | "notifications.unsubscribe"
  | "gateway.status"
  | "scenes.list"
  | "jobs.list"
  | "approval.respond"
  | "input.respond"
  | "userInput.respond"
  | "userInput.hold"
  | "userInput.preview"
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
  /** The turn (chat.send requestId) that armed this prompt, so a turn timeout can drain only its own. */
  requestId: string;
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingInputRequest {
  requestId: string;
  resolve: (answer: string) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const TURN_TIMEOUT_SYNTHESIS_GRACE_MS = 65_000;

interface RpcConnectionCloseOptions {
  abortInFlightTurns?: boolean;
}

function normalizeChatAttachmentMetadata(raw: unknown): SessionTranscriptAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const attachments = raw.flatMap((entry): SessionTranscriptAttachment[] => {
    if (!entry || typeof entry !== "object") return [];
    const source = entry as Record<string, unknown>;
    const filename = typeof source["filename"] === "string" ? source["filename"].trim() : "";
    if (!filename) return [];

    const attachment: SessionTranscriptAttachment = { filename };
    if (typeof source["relativePath"] === "string" && source["relativePath"].trim()) attachment.relativePath = source["relativePath"].trim();
    if (typeof source["externalUrl"] === "string" && source["externalUrl"].trim()) attachment.externalUrl = source["externalUrl"].trim();
    if (typeof source["contentType"] === "string" && source["contentType"].trim()) attachment.contentType = source["contentType"].trim();
    if (typeof source["previewMode"] === "string" && source["previewMode"].trim()) {
      attachment.previewMode = source["previewMode"].trim() as SessionTranscriptAttachment["previewMode"];
    }
    if (typeof source["size"] === "number" && Number.isFinite(source["size"])) attachment.size = source["size"];
    if (source["isDirectory"] === true) attachment.isDirectory = true;
    if (typeof source["title"] === "string" && source["title"].trim()) attachment.title = source["title"].trim();
    if (typeof source["sourceTool"] === "string" && source["sourceTool"].trim()) attachment.sourceTool = source["sourceTool"].trim();
    return [attachment];
  });

  return attachments.length > 0 ? attachments : undefined;
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
  effort?: EffortTier;
}

/**
 * Parse inline override flags from a message string.
 * Supported flags:
 *   --auto         — auto-approve all tool calls this turn
 *   --iter N       — override sub-agent maxIterations (0 = unlimited, else 1–50)
 *   --agent NAME   — force delegation to a specific agent
 *   --timeout N    — override turn timeout in seconds (0 = unlimited, else 10–3600)
 *   --effort TIER  — one-off effort tier for this message (low | medium | high | max)
 * Returns the cleaned message (flags stripped) and the parsed flags.
 */
function parseOverrideFlags(message: string): { clean: string; flags: OverrideFlags } {
  let clean = message;
  const flags: OverrideFlags = { autoApprove: false };

  const effortMatch = clean.match(/--effort\s+(\S+)/i);
  if (effortMatch) {
    const tier = resolveEffortTier(effortMatch[1]);
    if (tier) flags.effort = tier;
    clean = clean.replace(/\s*--effort\s+\S+/i, "");
  }

  if (/--auto\b/.test(clean)) {
    flags.autoApprove = true;
    clean = clean.replace(/\s*--auto\b/g, "");
  }

  const iterMatch = clean.match(/--iter\s+(\d+)\b/);
  if (iterMatch) {
    const parsedIterations = parseInt(iterMatch[1]!, 10);
    // An operator who types --iter 80 gets 80. The old Math.min(50, …) silently returned
    // 50 and reported nothing, which is the same class of defect as the unbounded grant an
    // enclosing timer ignored: an explicit human number overridden in silence. 200 stays as
    // the runaway backstop (and is what --iter 0 already meant), so a typo still cannot
    // spin forever.
    flags.maxIterationsOverride = parsedIterations === 0
      ? 200
      : Math.max(1, Math.min(200, parsedIterations));
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
  private pendingApprovals = new Map<string, PendingApproval>();
  private pendingInputRequests = new Map<string, PendingInputRequest>();
  /** Authenticated user for this connection (JWT subject), set at WS connect.
   *  Sessions are attributed to this so document-RAG user scope + per-user RBAC
   *  match the same identity uploads use. Undefined only if the token had no sub. */
  private readonly connUserId: string | undefined;
  /** Authenticated role (JWT `role` claim); admins may manage any session. */
  private readonly connRole: string | undefined;

  constructor(ws: WebSocket, connUserId?: string, connRole?: string) {
    this.connId = randomUUID();
    this.ws = ws;
    this.connUserId = connUserId;
    this.connRole = connRole;
    this.sendEvent({ type: "hello-ok", data: {
      connId: this.connId,
      version: "0.1.0",
      sessions: this.visibleSessions(),
    }});
    log.info({ connId: this.connId }, "RPC connection established");
  }

  /**
   * Admins may access any session. By role RANK of admin, not operator: operator is the role every
   * account gets by default, so an operator exemption exempted everyone, and any user could read,
   * drive, rewind or delete another user's session. The HTTP session routes draw the same line.
   */
  private isSessionAdmin(): boolean {
    return !!this.connRole && roleRank(this.connRole) >= roleRank("admin");
  }

  /**
   * Whether this connection may read/mutate the given session. Enforced so one
   * authenticated user cannot get/delete/archive/reset/rewind/resume another
   * user's (or another connection's) session by id. No-ops for auth-off / no-sub
   * connections (no identity to enforce) and for admins; unknown/unowned
   * sessions fall through to each handler's normal not-found path.
   */
  private canAccessSession(sid: string): boolean {
    if (!this.connUserId || this.isSessionAdmin()) return true;
    const rec = getSessionRecord(sid);
    if (!rec || rec.userId === undefined) return true;
    return rec.userId === this.connUserId;
  }

  /**
   * Who this connection is to the user-input broker: the same admin line as session access, since
   * answering a question in someone else's running turn puts words in their mouth.
   */
  private userInputCaller(): UserInputCaller {
    return {
      ...(this.connUserId ? { userId: this.connUserId } : {}),
      isAdmin: this.isSessionAdmin(),
    };
  }

  /**
   * May this connection stop a turn it did not start? The HTTP /stop route's owner-or-admin line
   * (callerMayUseSession) and this connection's own session access, whichever is stricter.
   */
  private mayStopTurnIn(sessionId: string): boolean {
    const caller = this.connUserId ? { username: this.connUserId, role: normalizeRole(this.connRole) } : null;
    return this.canAccessSession(sessionId) && callerMayUseSession(caller, sessionId);
  }

  /**
   * May this connection see an audit event? The stream carried every user's tool calls, arguments
   * and all, and their session ids, to any authenticated socket, viewers included (review #27).
   * Admins and connections without an identity see everything; anyone else the events of sessions
   * they may access — a specialist's or a workflow's session counting as its chat's — and events
   * with no session that are their own.
   */
  private mayWatchAuditEvent(event: AuditEvent): boolean {
    if (!this.connUserId || this.isSessionAdmin()) return true;
    if (!event.sessionId) return event.userId !== undefined && event.userId === this.connUserId;
    const owner = getSessionRecord(owningChatSessionId(event.sessionId));
    return owner !== undefined && (owner.userId === undefined || owner.userId === this.connUserId);
  }

  /** Settings as a session shows them: its own choices over the defaults. session.get and
   *  session.updateSettings answer with the same shape, or a reply without the default effort
   *  reset the web's effort chip to "medium" (review #5). */
  private sessionSettingsView(settings: object): Record<string, unknown> {
    return { effort: getConfig().effort?.default ?? "medium", imageSettingsPrompt: "ask", ...settings };
  }

  /** Settle what a turn left waiting on this connection — approvals and ask_user questions — so the
   *  tool parked on one unblocks now and its hold on the clocks ends with the turn. */
  private settleTurnPrompts(requestId: string): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.requestId !== requestId) continue;
      clearTimeout(pending.timeout);
      this.pendingApprovals.delete(id);
      pending.resolve(false);
    }
    for (const [id, pending] of this.pendingInputRequests) {
      if (pending.requestId !== requestId) continue;
      clearTimeout(pending.timeout);
      this.pendingInputRequests.delete(id);
      pending.resolve("");
    }
  }

  /** Session list scoped to what this connection may see (own + unowned; all for admins). */
  private visibleSessions(): SessionSummary[] {
    const all = listSessions({ includeArchived: true });
    if (!this.connUserId || this.isSessionAdmin()) return all;
    return all.filter((s) => s.userId === undefined || s.userId === this.connUserId);
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
      case "gateway.status": {
        const requestId = typeof params["requestId"] === "string" && params["requestId"].trim()
          ? String(params["requestId"])
          : undefined;
        // Any live turn of a session this connection may use, not only one it started: the page
        // that probes after a reconnect is asking about the turn it followed before it.
        const live = requestId ? liveChatTurns.get(requestId) : undefined;
        const activeTurn = requestId !== undefined
          && (this.abortControllers.has(requestId) || (live !== undefined && !live.signal.aborted && this.canAccessSession(live.sessionId)));
        return {
          status: "running",
          sessions: listSessions().length,
          uptime: process.uptime(),
          ...(requestId ? { requestId, activeTurn } : {}),
        };
      }

      case "session.create": {
        let workspacePath: string | undefined = undefined;
        // In local/dev contexts, we allow setting a workspace path.
        // In a real deployed environment, this should be overridden or constrained by the gateway.
        if (params["workspacePath"]) {
          const requestedPath = String(params["workspacePath"]);
          // SECURITY: Only allow relative paths inside a safe workspace root, never absolute host paths like "/".
          // EVL-401: when gateway.sessionWorkspaceRoot is configured, the relative path resolves
          // under that root (containment enforced) so eval fixtures on a container mount are
          // reachable; unset keeps the legacy raw-relative behavior.
          const resolution = resolveSessionWorkspaceOverride(requestedPath, getConfig().gateway?.sessionWorkspaceRoot);
          if (!resolution.ok) {
             log.warn({ requestedPath, reason: resolution.reason, connId: this.connId }, "Rejected workspacePath override");
             throw new Error(`Invalid workspacePath: ${resolution.reason}`);
          }
          workspacePath = resolution.path;
        }

        const session = createSession({
          channel: String(params["channel"] ?? "webchat"),
          // Attribute the session to the authenticated connection user (so the
          // document-RAG user scope + RBAC match the identity uploads use). The
          // server-derived identity wins over any client-supplied userId.
          userId: this.connUserId ?? (params["userId"] ? String(params["userId"]) : undefined),
          ...(this.connRole ? { userRole: this.connRole } : {}),
          workspacePath,
        });
        this.activeSessionId = session.id;
        return { sessionId: session.id };
      }

      case "session.end": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        if (sid && !this.canAccessSession(sid)) throw new Error(`Session not found: ${sid}`);
        archiveSession(sid);
        if (this.activeSessionId === sid) this.activeSessionId = null;
        return { ended: true };
      }

      case "session.archive": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        if (sid && !this.canAccessSession(sid)) throw new Error(`Session not found: ${sid}`);
        const archived = archiveSession(sid);
        if (this.activeSessionId === sid) this.activeSessionId = null;
        return { archived, sessionId: sid };
      }

      case "session.delete": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        if (sid && !this.canAccessSession(sid)) throw new Error(`Session not found: ${sid}`);
        const deleted = deleteSession(sid);
        // What its turns left unread goes with the chat (review of round 2, B #4).
        turnSteeringManager.dropUnread(sid);
        if (this.activeSessionId === sid) this.activeSessionId = null;
        return { deleted, sessionId: sid };
      }

      case "session.get": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        if (sid && !this.canAccessSession(sid)) throw new Error(`Session not found: ${sid}`);
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
        // Surface per-session effort/time-limit settings so the composer can hydrate
        // its controls; fall back to the configured default tier when unset.
        const settings = getSessionRecord(sid)?.getSettings() ?? {};
        // A reloaded page gets the questions still waiting for it, and from now on the events of
        // new ones and of steering a turn leaves unread: the turn's other events stay bound to the
        // socket that started it.
        const caller = this.userInputCaller();
        const mayAnswer = userInputBroker.canAnswerFor(sid, caller);
        if (mayAnswer) userInputBroker.attachSink(sid, this.connId, (event) => this.sendEvent(event), caller);
        const liveTurn = liveChatTurnOf(sid);
        const unreadSteering = mayAnswer ? turnSteeringManager.unreadOf(sid) : [];
        return {
          ...transcript,
          settings: this.sessionSettingsView(settings),
          // A page reloaded mid-turn, or a second tab, learns the turn is still running — and which
          // turn, and since when — so it can steer or stop that turn. A chat.send it makes anyway
          // supersedes the running turn rather than starting a second one beside it.
          activeTurn: turnSteeringManager.isTurnActive(sid) || liveTurn !== undefined,
          ...(liveTurn ? { activeTurnRequestId: liveTurn.requestId, activeTurnStartedAt: liveTurn.startedAt } : {}),
          openUserInputs: mayAnswer ? userInputBroker.listOpen(sid, caller) : [],
          // Messages a finished turn never read, whose final status went to a socket that was gone.
          // Only the owner's (or an admin's): they are the person's own words.
          ...(unreadSteering.length > 0 ? { unreadSteering } : {}),
          // This clock, when it answered: a question first seen in openUserInputs after a reload
          // carries server deadlines, and the page needs the skew to count them down.
          serverNow: Date.now(),
        };
      }

      case "session.list":
        return this.visibleSessions();

      case "session.updateSettings": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        if (sid && !this.canAccessSession(sid)) throw new Error(`Session not found: ${sid}`);
        const session = getSessionRecord(sid);
        if (!session) throw new Error(`Session not found: ${sid}`);
        const patch: { effort?: EffortTier; turnTimeoutSecOverride?: number; imageSettingsPrompt?: "auto" } = {};
        if ("effort" in params) {
          // null / "" / "default" clears the override (reset to the global default).
          const raw = params["effort"];
          patch.effort = raw == null || raw === "" || raw === "default"
            ? undefined
            : resolveEffortTier(raw);
        }
        if ("turnTimeoutSec" in params) {
          const raw = params["turnTimeoutSec"];
          patch.turnTimeoutSecOverride = raw == null || raw === ""
            ? undefined
            : Math.max(0, Math.min(86_400, Number(raw) || 0));
        }
        if ("imageSettingsPrompt" in params) {
          // "ask" is the default, so it is stored as no setting at all, like a cleared effort.
          const raw = params["imageSettingsPrompt"];
          if (raw === "auto") patch.imageSettingsPrompt = "auto";
          else if (raw == null || raw === "" || raw === "ask" || raw === "default") patch.imageSettingsPrompt = undefined;
          else throw new Error('imageSettingsPrompt must be "ask" or "auto"');
        }
        const updated = session.setSettings(patch);
        return { settings: this.sessionSettingsView(updated) };
      }

      case "session.reset": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        if (sid && !this.canAccessSession(sid)) throw new Error(`Session not found: ${sid}`);
        getSessionRecord(sid)?.reset();
        // Left in place, the old turns' unread messages came back into the emptied chat with every
        // session.get, as undelivered, with a Resend (review of round 2, B #4).
        turnSteeringManager.dropUnread(sid);
        return { reset: true };
      }

      case "session.rewind": {
        const sid = String(params["sessionId"] ?? this.activeSessionId ?? "");
        if (sid && !this.canAccessSession(sid)) throw new Error(`Session not found: ${sid}`);
        const historyIndex = Number(params["historyIndex"] ?? -1);
        if (!Number.isInteger(historyIndex) || historyIndex < 0) {
          throw new Error("session.rewind requires a non-negative integer historyIndex");
        }
        const session = getSessionRecord(sid);
        if (!session) throw new Error(`Session not found: ${sid}`);
        const lengthBefore = session.getHistory().length;
        session.rewindBeforeIndex(historyIndex);
        // They sat at the end of the history this cut off. An index at or past the end cuts
        // nothing, and must not throw away what the person typed (review of round 3, B #2).
        if (session.getHistory().length !== lengthBefore) turnSteeringManager.dropUnread(sid);
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
          // Use reject when the user explicitly denies so the error message
          // says "denied by user"; use resolve(true) for explicit approval.
          if (approved) {
            pending.resolve(true);
          } else {
            pending.reject(new Error(`Tool approval explicitly denied by user`));
          }
        }
        return { ok: true };
      }

      case "input.respond": {
        const inputId = String(params["inputId"] ?? "");
        const answer = String(params["answer"] ?? "");
        const pendingInput = this.pendingInputRequests.get(inputId);
        // An answer to a question that already timed out used to report ok and vanish, and the
        // person believed they had been heard.
        if (!pendingInput) return { ok: false, errors: [{ field: "inputId", message: "expired" }] };
        clearTimeout(pendingInput.timeout);
        this.pendingInputRequests.delete(inputId);
        pendingInput.resolve(answer);
        return { ok: true };
      }

      // Structured questions from tools at any depth (agent/user-input-broker.ts). Not scoped to
      // this connection: a reloaded page or a second tab of the session owner answers too.
      case "userInput.respond": {
        return userInputBroker.respond(String(params["inputId"] ?? ""), params["answer"], this.userInputCaller());
      }

      case "userInput.hold": {
        const held = userInputBroker.hold(String(params["inputId"] ?? ""), this.userInputCaller());
        if (!held) throw new Error("User input request not found or expired");
        return held;
      }

      case "userInput.preview": {
        const preview = await userInputBroker.preview(
          String(params["inputId"] ?? ""),
          String(params["candidateId"] ?? ""),
          this.userInputCaller(),
        );
        if (!preview) throw new Error("Preview not available");
        return preview;
      }

      case "chat.send": {
        const sessionId = String(params["sessionId"] ?? this.activeSessionId ?? "");
        // Don't let a caller drive a turn on another user's existing session
        // (a not-yet-created session id falls through — it will be owned by them).
        // Stays the BARE message: an ownership denial must not describe the session's
        // fate, or the id becomes probeable for existence.
        if (sessionId && !this.canAccessSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
        let message = String(params["message"] ?? "");
        const displayContent = typeof params["displayContent"] === "string" ? String(params["displayContent"]).trim() : undefined;
        const userAttachments = normalizeChatAttachmentMetadata(params["attachments"]);
        const requestId = String(params["requestId"] ?? randomUUID());
        // The client picks the id, and the turn registry, the Stop and the turn's questions are all
        // keyed by it: a second turn under a live id took the entry over, so the first could no
        // longer be stopped from a reloaded page and its own tab's Stop hit the other turn (review
        // of round 1, B #6). Refused before anything is sent under that id.
        if (liveChatTurns.has(requestId)) throw new Error(`requestId ${requestId} is already in use by a running turn`);
        const enableThinkingRaw = params["enableThinking"];
        const enableThinking: boolean | undefined =
          enableThinkingRaw === true || enableThinkingRaw === "true" ? true :
          enableThinkingRaw === false || enableThinkingRaw === "false" ? false :
          undefined;

        // Parse inline override flags (--auto, --iter N, --agent NAME, --effort TIER) before scene handling
        const { clean: cleanMessage, flags: overrideFlags } = parseOverrideFlags(message);
        message = cleanMessage;

        // Resolve the effort tier for this turn: inline --effort flag (one-off) >
        // per-message `effort` param > persisted session setting > configured default.
        const sessionSettings = getSessionRecord(sessionId)?.getSettings() ?? {};
        const effortTier: EffortTier =
          overrideFlags.effort
          ?? resolveEffortTier(params["effort"])
          ?? sessionSettings.effort
          ?? getConfig().effort?.default
          ?? "medium";
        const effortProfile = resolveEffortProfile(effortTier);

        // Effective turn timeout: --timeout flag > per-session time-limit override >
        // the effort profile's timeout (0 = unlimited) > the gateway config default.
        const effectiveTurnTimeoutMs =
          overrideFlags.turnTimeoutSec !== undefined ? overrideFlags.turnTimeoutSec * 1000
          : sessionSettings.turnTimeoutSecOverride !== undefined ? sessionSettings.turnTimeoutSecOverride * 1000
          : effortProfile.turnTimeoutMs !== undefined ? effortProfile.turnTimeoutMs
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
            // Surface a non-baseline effort tier (from --effort flag or session setting).
            ...(effortTier !== "medium" ? { effort: effortTier } : {}),
          };
          this.sendEvent({ type: "status", data: { status: "accepted", requestId, ...(Object.keys(activeFlagsPayload).length ? { activeFlags: activeFlagsPayload } : {}) } });
        }

        if (!sessionId) throw new Error("No active session — call session.create first");
        // resumeArchived: a turn the watchdog timed out is PARKED, not ended — the
        // recovered delivery and that turn's partial artifacts are still in its history,
        // so "continue" must land on the same session instead of dead-ending. Explicit
        // ("manual") archives stay unresumable and fall through to the not-found path,
        // which now names WHICH benign cause applies (pruned / deleted / unknown here).
        const session = getSession(sessionId) ?? await resolveSession(sessionId, { resumeArchived: true });
        if (!session) throw new Error(`Session not found: ${sessionId} — ${describeMissingSession(sessionId)}`);

        // A turn already running on this session is superseded, whichever connection started it.
        // Only this connection's own turn used to be: after a reload or from a second tab, a send
        // started a second turn beside the first, both writing one history, and the new turn took
        // the old one's steering. The old turn now ends as a supersede and reports its leftovers.
        const superseded = liveChatTurnOf(session.id);
        if (superseded && superseded.requestId !== requestId) superseded.abort();

        const ac = new AbortController();
        const turnStartedAt = Date.now();
        this.abortControllers.set(requestId, ac);
        const liveTurn: LiveChatTurn = {
          requestId,
          sessionId: session.id,
          startedAt: turnStartedAt,
          signal: ac.signal,
          abort: () => {
            if (ac.signal.aborted) return false;
            ac.abort();
            this.abortControllers.delete(requestId);
            // Stop means stop: an open question closes now, not when the aborted turn unwinds, and
            // a tool that asks after this hears "cancelled".
            userInputBroker.closeTurn(requestId, "aborted");
            this.settleTurnPrompts(requestId);
            return true;
          },
        };
        liveChatTurns.set(requestId, liveTurn);
        liveChatTurnBySession.set(session.id, requestId);
        // Steering opens here, not when the runtime is through its start-up awaits: a message
        // sent in that gap found no turn, and the client's fallback send cancelled the turn it
        // was meant for.
        const steeringToken = randomUUID();
        const retiredUnread = turnSteeringManager.armTurn(session.id, steeringToken);
        // What this turn leaves unread belongs to the history as it stands now (sendFinalStatus).
        const steeringDropMark = turnSteeringManager.dropMark();
        const closeSteering = () => turnSteeringManager.closeTurn(session.id, steeringToken).map(({ id, text }) => ({ id, text }));
        // Tools of this turn may ask the person structured questions, at any depth; --auto has
        // nobody to ask. The questions go to this socket and to any tab that loads the session.
        const interactiveTurn = !overrideFlags.autoApprove;
        if (interactiveTurn) {
          userInputBroker.openTurn(requestId, session.id, session.userId);
          userInputBroker.attachSink(session.id, this.connId, (event) => this.sendEvent(event), this.userInputCaller());
        }

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let timedOut = false;
        let completed = false;
        // Last sign of life from this turn — its own text, its reasoning, or any delegate's
        // progress. The watchdog below consults it instead of deciding on elapsed time alone.
        let lastTurnActivityAt = 0;
        const noteTurnActivity = (): void => { lastTurnActivityAt = Date.now(); };
        // When the watchdog fires next, so a credit below never pulls it EARLIER than a liveness
        // re-check it already scheduled.
        let watchdogFiresAt = 0;
        const armWatchdog = (delayMs: number): void => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          watchdogFiresAt = Date.now() + delayMs;
          timeoutHandle = setTimeout(endTimedOutSession, delayMs);
        };
        // The person answering a question this turn asked is not the turn's time: the watchdog
        // holds while they do, and the deadline moves by the wait's length when they are done.
        // The runtime credits its own deadline the same way and leaves these minutes out of the
        // delegation wait it reports below, so they are counted once. The liveness beat moves
        // with it: left where it was, the first check after a long answer read the whole wait as
        // silence and timed out a turn that was producing right up to its question (review #13).
        const humanWaits = trackHumanWaits(session.id, (waitedMs) => {
          if (lastTurnActivityAt > 0) lastTurnActivityAt = Math.min(Date.now(), lastTurnActivityAt + waitedMs);
          if (gatewayDeadlineMs <= 0 || timedOut || completed) return;
          gatewayDeadlineMs = Math.min(gatewayDeadlineMs + waitedMs, turnStartedAt + MAX_GATEWAY_TURN_MS);
          if (gatewayDeadlineMs > watchdogFiresAt) armWatchdog(gatewayDeadlineMs - Date.now());
        }, { turnId: requestId });

        const cleanupTurn = () => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          humanWaits.dispose();
          // Questions still open when the turn ends have nobody left to act on the answer.
          userInputBroker.closeTurn(requestId, timedOut ? "aborted" : "ended");
          this.abortControllers.delete(requestId);
          if (liveChatTurns.get(requestId) === liveTurn) {
            liveChatTurns.delete(requestId);
            if (liveChatTurnBySession.get(session.id) === requestId) liveChatTurnBySession.delete(session.id);
            rememberEndedChatTurn(requestId, session.id);
          }
        };
        // The turn's final status goes to the socket that started it, with the steering it never
        // read. After a reload that socket is gone, and those messages stayed "Queued" on the page
        // that sent them; the session keeps them for session.get instead (review of round 1, B #5).
        // They also go at once to the session's open pages, in session.get's shape: a stopped turn
        // slow to notice its abort unwinds after the next send has started, which session.get and
        // that send's reply both missed, so they surfaced a whole turn late (review of round 3, B #1).
        const sendFinalStatus = (data: Record<string, unknown>, leftovers: readonly SteeringMessage[] = []): void => {
          const delivered = this.sendEvent({ type: "status", data: leftovers.length > 0 ? { ...data, unconsumedSteering: leftovers } : data });
          if (delivered || leftovers.length === 0) return;
          // Neither kept nor pushed once the chat was reset, rewound or deleted after this turn
          // started: a stopped turn slow to unwind brought them back into the emptied chat right
          // after they were dropped (review of round 4, B #2).
          if (!turnSteeringManager.keepUnread(session.id, requestId, leftovers, steeringDropMark)) return;
          userInputBroker.emitToOwner(session.id, {
            type: "agent.unread_steering",
            data: { sessionId: session.id, messages: leftovers.map(({ id, text }) => ({ id, text, requestId })) },
          });
        };

        // --agent flag overrides sceneAllowedAgents (narrows to a single agent)
        const effectiveAllowedAgents = overrideFlags.forceAgent
          ? [overrideFlags.forceAgent]
          : sceneAllowedAgents;

        const endTimedOutSession = () => {
          if (timedOut || completed) return;
          // The operator's unbounded grant suspends this watchdog. It is the timer that
          // actually killed run 3959f3ac: the dock promised "let it finish naturally" at
          // 07:35:24 and this fired at 07:54:36 anyway (turn_timeout_recovered, timeoutMs
          // 1800000), because the grant reached the sub-agent's own deadline and nothing
          // else. A grant honoured by some enclosing bounds and not others is the same bug
          // as a grant honoured by none. Re-arm rather than cancel, so the watchdog resumes
          // if the grant is ever cleared.
          if (longRunningGenerationManager.isTurnUnbounded(sessionId)) {
            log.info(
              { sessionId, requestId },
              "Gateway turn watchdog suspended — this turn holds an operator unbounded grant",
            );
            armWatchdog(GRANTED_TURN_RECHECK_MS);
            return;
          }
          // Held, but never past the absolute ceiling: request_human_assist's wait length came from
          // the model, and this branch re-armed forever where the liveness branch stops (review #29).
          if (humanWaits.isWaiting() && Date.now() - turnStartedAt < MAX_GATEWAY_TURN_MS) {
            log.info({ sessionId, requestId }, "Gateway turn watchdog held — the turn is waiting on the person or on work they approved");
            armWatchdog(HUMAN_WAIT_RECHECK_MS);
            return;
          }
          // THE SAME CLOCK, ON THE OTHER SURFACE.
          //
          // agui.ts got this deferral; this did not, and this is the path the dashboard
          // actually uses — so session e95eec63 was cut at 31 minutes by the one gateway
          // watchdog that still decided on elapsed time alone, having spent 18 of those
          // minutes inside a single orchestrator completion. Fixing one surface and not its
          // twin has been the recurring shape of this whole area: the heartbeat, the
          // delegation-wait clock and the sub-agent event stream each landed on AG-UI first
          // and had to be chased onto RPC afterwards.
          //
          // A turn that produced something within the recheck window is alive and the
          // watchdog re-arms; one that has gone quiet stops deferring on the very next
          // check, and the absolute ceiling still bounds a turn that chatters forever.
          const sinceActivityMs = lastTurnActivityAt > 0 ? Date.now() - lastTurnActivityAt : Infinity;
          if (sinceActivityMs < TURN_LIVENESS_RECHECK_MS && Date.now() - turnStartedAt < MAX_GATEWAY_TURN_MS) {
            log.info(
              { sessionId, requestId, sinceActivityMs },
              "Gateway turn watchdog deferred — the turn is still producing",
            );
            armWatchdog(TURN_LIVENESS_RECHECK_MS);
            return;
          }
          timedOut = true;
          ac.abort();
          cleanupTurn();
          // Settle + clear any approval/input prompts THIS turn armed, so their
          // minutes-long timers and map entries don't leak past archival and the
          // runtime await parked in the tool layer unblocks. Mirrors close()'s
          // resolve(false)/resolve("") sweep; scoped to this requestId so a
          // concurrent turn's prompts on the same connection are untouched.
          this.settleTurnPrompts(requestId);
          // NOTE: activeSessionId is deliberately left pointing at this session. The
          // timeout parks it rather than ending it, so a follow-up with no explicit
          // sessionId ("continue") must still resolve here instead of failing with
          // "No active session"; chat.send un-parks it on arrival.
          // Never dead-end into an empty bubble (audit b6f8336e, 0dc158ad turn 2):
          // the hard timeout aborts the runtime before synthesis, so recover the
          // best-available content from the session and deliver THAT instead of a
          // bare status:error. Persist it before archiving so the transcript isn't
          // empty either. Fully defensive — any failure falls back to the error.
          let delivery: { response: string; recoveredAssistantText: boolean } | null = null;
          try {
            delivery = buildTimeoutDeliveryMessage(session, { effortTier, timeoutMs: effectiveTurnTimeoutMs });
          } catch (err) {
            log.warn({ err, sessionId: session.id }, "Timeout best-available recovery failed");
          }
          if (delivery?.response) {
            try { session.addMessage({ role: "assistant", content: delivery.response }); } catch { /* archive anyway */ }
          }
          // "timeout", not the default "manual": this parks the session (dropped from the
          // hot set, consolidated, kept on the long retention) while leaving it resumable,
          // so the follow-up message continues the turn's preserved partial work.
          archiveSession(session.id, "timeout");
          // The runtime is still unwinding and would hand these back to a status nobody sends.
          const unconsumedSteering = closeSteering();
          if (delivery?.response) {
            logAudit("turn_timeout_recovered", {
              requestId,
              recoveredAssistantText: delivery.recoveredAssistantText,
              chars: delivery.response.length,
              timeoutMs: effectiveTurnTimeoutMs,
              effortTier,
            }, { sessionId: session.id, severity: "warn" });
            sendFinalStatus({ status: "ok", requestId, response: delivery.response, finishReason: "timeout" }, unconsumedSteering);
          } else {
            sendFinalStatus({
              status: "error",
              requestId,
              error: `Turn exceeded the timeout window and did not finish synthesis. The session is parked — send another message to continue it.`,
            }, unconsumedSteering);
          }
        };

        // D5: the gateway's hard timeout must stay in lockstep with the runtime's delegation-wait
        // exclusion — else it guillotines a turn whose runtime budget legitimately paused for a child.
        // Track the deadline so onDelegationWaitMs can push it out by the same blocked duration, capped
        // at the same absolute ceiling (+ synthesis grace so the runtime aborts + synthesizes first).
        let gatewayDeadlineMs = 0;
        let gatewayDeadlineCeilingMs = 0;
        // Same correction as agui.ts / runtime.ts: the ceiling is the turn budget PLUS the
        // delegation-wait allowance. With the bare allowance it equalled the deadline at the
        // shipped config, so this surface's D5 extension was a no-op too.
        if (effectiveTurnTimeoutMs > 0) {
          const armedAt = Date.now();
          gatewayDeadlineMs = armedAt + effectiveTurnTimeoutMs + TURN_TIMEOUT_SYNTHESIS_GRACE_MS;
          gatewayDeadlineCeilingMs = resolveDelegationWaitCeilingMs(armedAt, effectiveTurnTimeoutMs, TURN_TIMEOUT_SYNTHESIS_GRACE_MS);
          armWatchdog(effectiveTurnTimeoutMs + TURN_TIMEOUT_SYNTHESIS_GRACE_MS);
        }
        const extendGatewayDeadline = (ms: number): void => {
          if (gatewayDeadlineMs <= 0 || timedOut || completed || ms <= 0) return;
          gatewayDeadlineMs = extendDeadlineForDelegationWait(gatewayDeadlineMs, ms, gatewayDeadlineCeilingMs);
          armWatchdog(Math.max(0, gatewayDeadlineMs - Date.now()));
        };

        if (
          overrideFlags.autoApprove
          || overrideFlags.maxIterationsOverride !== undefined
          || overrideFlags.forceAgent
          || overrideFlags.turnTimeoutSec !== undefined
          || effortTier !== "medium"
        ) {
          const flagSummary = [
            overrideFlags.autoApprove ? "auto-approve" : null,
            overrideFlags.maxIterationsOverride !== undefined ? `iter=${overrideFlags.maxIterationsOverride}` : null,
            overrideFlags.forceAgent ? `agent=${overrideFlags.forceAgent}` : null,
            overrideFlags.turnTimeoutSec !== undefined ? `timeout=${overrideFlags.turnTimeoutSec}s` : null,
            effortTier !== "medium" ? `effort=${effortTier}` : null,
          ].filter(Boolean).join(", ");
          log.info({ requestId, flags: flagSummary }, "Inline overrides active");
        }

        // The turn runs under this request id (RequestContext.turnId), so the watchdog's tracker above
        // and every wait of the run name the same turn — an --auto turn too, which has no question
        // channel to carry one (review of round 1, B #7).
        runWithRequestContext({ ...(currentRequestContext() ?? {}), turnId: requestId }, () => runTurn({
          session,
          userMessage: message,
          userDisplayContent: displayContent,
          // What the person typed. `message` can carry inlined image analysis (the web chat's typed
          // text is displayContent then), and after /run it is the scene's template, which is not
          // the user's words at all.
          userWords: runMatch
            ? undefined
            : typedUserWords(message, displayContent ? parseOverrideFlags(displayContent).clean : undefined),
          userAttachments,
          signal: ac.signal,
          allowedAgents: effectiveAllowedAgents,
          humanInLoopSteps,
          autoApprove: overrideFlags.autoApprove,
          maxIterationsOverride: overrideFlags.maxIterationsOverride,
          // Effort-aware timeout (flag > session override > profile > config); the runtime
          // and this gateway's archival timer share the same resolved value.
          turnTimeoutOverrideMs: effectiveTurnTimeoutMs,
          enableThinking,
          effortTier,
          // D5: keep the gateway hard-timeout in lockstep with the runtime's delegation-wait exclusion.
          onDelegationWaitMs: extendGatewayDeadline,
          steeringToken,
          ...(interactiveTurn ? { userInput: { rootSessionId: session.id, turnId: requestId, mode: "interactive" as const } } : {}),
          onChunk: (text) => {
            noteTurnActivity();
            this.sendEvent({ type: "agent.chunk", data: { requestId, text } });
          },
          onReasoning: (text) => {
            noteTurnActivity();
            this.sendEvent({ type: "agent.reasoning", data: { requestId, text } });
          },
          onStatus: (status) => {
            this.sendEvent({ type: "status", data: { requestId, status: status.phase, message: status.message, iteration: status.iteration } });
          },
          // The texts ride along so a tab that did not send them can still show them. The runtime
          // never throws away a written draft to fold a message in, hence discardedDraft is false.
          // segmentText is what the transcript keeps for the part before this cut, read from the
          // transcript itself (the messages are already in history), so live and reload agree.
          onSteeringConsumed: ({ messages, iteration, at }) => {
            noteTurnActivity();
            let segmentText = "";
            try {
              segmentText = steeringSegmentText(session.toTranscript(), new Set(messages.map((message) => message.id)));
            } catch (err) {
              log.warn({ err, sessionId: session.id }, "Steering segment text unavailable");
            }
            this.sendEvent({
              type: "agent.steering_consumed",
              data: { requestId, iteration, at, discardedDraft: false, messages, segmentText },
            });
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
            noteTurnActivity();
            if (event.kind === "reasoning" && event.reasoning) {
              this.sendEvent({
                type: "agent.reasoning",
                data: {
                  requestId,
                  text: event.reasoning,
                  sourceAgent: event.agentName,
                  delegated: true,
                },
              });
              return;
            }

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

            // A specialist's start and finish are status, not tool events: without them the pill
            // froze on the orchestrator's last phase for the minutes a specialist ran tool-less.
            const lifecycle = subAgentProgressStatus(event);
            if (lifecycle) {
              this.sendEvent({
                type: "status",
                data: { requestId, status: lifecycle.phase, message: lifecycle.message, iteration: lifecycle.iteration, sourceAgent: event.agentName, delegated: true },
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
            const approvalTimeoutMs = getConfig().gateway.approvalTimeoutMs;
            const expiresAt = new Date(Date.now() + approvalTimeoutMs).toISOString();
            this.sendEvent({
              type: "agent.approval_needed",
              data: { requestId, toolName, args, approvalId, timeoutMs: approvalTimeoutMs, expiresAt },
            });

            return new Promise<boolean>((resolve, reject) => {
              // Reject if the user does not respond — produces a
              // distinguishable error rather than a silent false ("denied by user")
              // so the approval-timeout intervention can explain what happened.
              const timeout = setTimeout(() => {
                this.pendingApprovals.delete(approvalId);
                log.warn({ approvalId, toolName }, "Approval timed out — denying");
                reject(new Error(`Tool '${toolName}' approval timed out (no response within ${formatApprovalTimeout(approvalTimeoutMs)})`));
              }, approvalTimeoutMs);
              this.pendingApprovals.set(approvalId, { requestId, resolve, reject, timeout });
            });
          },
          inputCallback: async (question, choices, requestedTimeoutMs) => {
            const inputId = randomUUID();
            // The deadline travels with the question, as it does for approvals, so the card can
            // count down and close itself instead of outliving the wait.
            const timeoutMs = clampUserInputTimeoutMs(requestedTimeoutMs);
            const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
            this.sendEvent({ type: "agent.input_needed", data: { requestId, inputId, question, choices, timeoutMs, expiresAt } });

            return new Promise<string>((resolve) => {
              const timeout = setTimeout(() => {
                this.pendingInputRequests.delete(inputId);
                log.warn({ inputId }, "User input timed out — returning empty string");
                resolve("");
              }, timeoutMs);
              this.pendingInputRequests.set(inputId, { requestId, resolve, timeout });
            });
          },
        })).then(output => {
          if (timedOut || completed) return;
          completed = true;
          cleanupTurn();
          // What was queued after the last drain rides along: the client sends it on as the next turn.
          sendFinalStatus({
            status: output.blocked ? "blocked" : "ok",
            requestId,
            response: output.response,
            toolCallsExecuted: output.toolCallsExecuted,
            guardrailEvents: output.guardrailEvents,
            usage: output.usage,
            swarmState: output.swarmState,
            performance: output.performance,
          }, output.unconsumedSteering ?? []);
        }).catch(err => {
          if (timedOut || completed) return;
          completed = true;
          cleanupTurn();
          // The runtime records what it never drained on the error it throws; a turn that failed
          // before it got going left them in the queue this call armed.
          sendFinalStatus({ status: "error", requestId, error: String(err) }, [...unconsumedSteeringOf(err), ...closeSteering()]);
        });

        // What earlier turns left unread and this start retired goes back to the page that sent it,
        // in session.get's shape. The web stops its own turn with chat.cancel before it sends, and a
        // turn that unwound in between had its leftovers kept for the session and dropped by this
        // start at once, shown to nobody (review of round 2, B #5). Only the owner's (or an
        // admin's), as in session.get.
        const unreadSteering = retiredUnread.length > 0 && userInputBroker.canAnswerFor(session.id, this.userInputCaller())
          ? retiredUnread
          : [];
        return { accepted: true, requestId, ...(unreadSteering.length > 0 ? { unreadSteering } : {}) };
      }

      case "chat.cancel": {
        const requestId = String(params["requestId"] ?? "");
        // Not only this connection's own turns. After a reconnect the page still follows the turn
        // by its request id, but the new socket held no controller for it: Stop aborted nothing,
        // left the open question to run out into a render, and the page said "cancelled" (review
        // #15/#39). A turn another connection started is stopped the same way, for a caller the
        // HTTP /stop route would let stop it. `cancelled` says whether this call stopped a turn.
        // `known` says whether this process runs the turn or ran it lately, for a caller who may stop
        // it: `cancelled: false` alone read the same for a turn that had just ended as for one held
        // by another instance, and a session-wide Stop sent for the first stopped the turn after it
        // (review of round 1, B #3). Only an unknown turn may be stopped some other way.
        const live = liveChatTurns.get(requestId);
        const sessionOf = knownChatTurnSession(requestId);
        const known = sessionOf !== undefined && (this.abortControllers.has(requestId) || this.mayStopTurnIn(sessionOf));
        const cancelled = known && live !== undefined && live.abort();
        return { cancelled, requestId, known };
      }

      case "audit.subscribe": {
        if (this.auditUnsubscribe) this.auditUnsubscribe();
        this.auditUnsubscribe = subscribeToAudit(event => {
          if (!this.mayWatchAuditEvent(event)) return;
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
    // Structured questions outlive the socket: they stay open until their own deadline, for a
    // reloaded page or another tab to answer (session.get lists them).
    userInputBroker.detachSink(this.connId);
    log.info({ connId: this.connId }, "RPC connection closed");
  }

  /** True when the event was handed to an open socket. */
  private sendEvent(event: GatewayEvent): boolean {
    return this.sendRaw({ ...event });
  }

  private sendResponse(res: RpcResponse): void {
    this.sendRaw({ type: "rpc.response", ...res });
  }

  private sendRaw(data: unknown): boolean {
    if (this.ws.readyState === 1 /* OPEN */) {
      try {
        this.ws.send(JSON.stringify(data));
        return true;
      } catch (err) {
        log.error({ err }, "Failed to send WS message");
      }
    }
    return false;
  }
}
