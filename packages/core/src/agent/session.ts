import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  computePromptTokenBudget,
  estimatePromptTokensForRequest,
  PROMPT_ESTIMATE_CHARS_PER_TOKEN,
  type LLMMessage,
} from "../providers/lmstudio.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import { userWorkspaceRoot } from "../tools/workspace-path.js";
import type { EffortTier } from "../config/schema.js";
import { formatMainAssistantPersonalityGuidance } from "../personality/service.js";
import { formatOutcomesForPrompt } from "./outcomes.js";
import { sanitizeTranscriptContent } from "./sanitize-response.js";
import type { SwarmState } from "../tools/registry.js";
import {
  saveSessionToRedis,
  loadSessionFromRedis,
  deleteSessionFromRedis,
  loadAllSessionsFromRedis,
} from "./session-redis.js";

import { PRODUCT } from "../product/index.js";

const log = childLogger("agent:session");
const TRANSIENT_TURN_SYSTEM_PREFIXES = [
  "[SYNTHESIS REQUIRED]",
  "[WARDEN STOP — FORCED SYNTHESIS]",
  "[CONTINUE ORCHESTRATION]",
  // The plan-continuation directive is per-iteration guidance; kept, it told a later turn to
  // finish a plan the turn boundary had already cleared.
  "[CONTINUE PLAN]",
  "[USER RESPONSE REQUIRED]",
  "[DELEGATION FAILED]",
  "[USER INTERACTION OWNERSHIP]",
  // Per-turn document-RAG context (engram excerpts for the current message).
  // Pruned next turn so retrieved excerpts never accumulate in history.
  "[DOCUMENT CONTEXT]",
];

function isTransientTurnSystemMessage(message: Pick<SessionHistoryMessage, "role" | "content">): boolean {
  const content = typeof message.content === "string" ? message.content : "";
  return message.role === "system"
    && TRANSIENT_TURN_SYSTEM_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Per-session tuning the user controls from the chat composer. `effort` selects an
 * effort profile (see runtime/effort-context.ts); `turnTimeoutSecOverride` is an
 * optional independent time-limit override (seconds; 0 = unlimited) that wins over
 * the profile's own timeout. Both persist with the session.
 */
export interface SessionSettings {
  effort?: EffortTier;
  turnTimeoutSecOverride?: number;
}

/** Why a session was archived — drives which retention the pruner applies and whether
 *  a follow-up message resumes it. */
export type ArchivedReason = "idle" | "manual" | "timeout";

/** Archive reasons that PARK a session rather than end it. The user never asked to stop
 *  (the turn ran out of clock, or the sweep retired a quiet chat), so the next message
 *  must continue THAT conversation instead of dead-ending on "Session not found" — the
 *  timed-out turn's recovered delivery and its partial artifacts live in that history.
 *  "manual" is deliberately excluded: an explicit archive is an explicit end. */
const RESUMABLE_ARCHIVE_REASONS: ReadonlySet<ArchivedReason> = new Set<ArchivedReason>(["idle", "timeout"]);

export function isResumableArchive(reason: ArchivedReason | undefined): boolean {
  return reason !== undefined && RESUMABLE_ARCHIVE_REASONS.has(reason);
}

export interface AgentSessionOptions {
  sessionId?: string;
  channel: string;
  userId?: string;
  /** Authenticated role (JWT `role` claim) of the user that owns this session, when
   *  under active multi-user auth. Threaded into the turn's ToolContext so tools can
   *  gate mutating actions by role (e.g. operator-only knowledge-base management),
   *  matching the REST/MCP surfaces. Undefined for auth-off / channel-originated turns. */
  userRole?: string;
  systemPrompt?: string;
  workspacePath?: string;
  settings?: SessionSettings;
}

export interface TurnResult {
  response: string;
  toolCallsExecuted: number;
  usage: { promptTokens: number; completionTokens: number };
  guardrailEvents: string[];
}

export interface SessionHistoryMessage extends LLMMessage {
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface SessionSummary {
  id: string;
  channel: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  turns: number;
  messageCount: number;
  lastMessageAt?: string;
  preview?: string;
}

export interface SessionTranscriptMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: string;
  attachments?: SessionTranscriptAttachment[];
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result?: string; metadata?: Record<string, unknown> }>;
  swarmState?: SwarmState;
}

export interface SessionTranscriptAttachment {
  filename: string;
  relativePath?: string;
  externalUrl?: string;
  contentType?: string;
  previewMode?: "image" | "html" | "pdf" | "text" | "markdown" | "json" | "audio" | "mermaid" | "website" | "download";
  size?: number;
  isDirectory?: boolean;
  title?: string;
  sourceTool?: string;
}

export interface SessionTranscriptPage {
  session: SessionSummary;
  transcript: SessionTranscriptMessage[];
  totalMessages: number;
  nextBeforeMessageId?: string;
}

export interface PersistedSessionRecord {
  id: string;
  channel: string;
  userId?: string;
  userRole?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  archivedReason?: ArchivedReason;
  systemPrompt: string;
  workspacePath: string;
  turnCount: number;
  history: SessionHistoryMessage[];
  /** Rolling digest of trimmed-out turns; absent on records written before
   *  history compaction shipped. */
  earlierSummary?: string;
  /** Per-session effort/time-limit settings; absent on records written before
   *  session settings shipped (→ inherits the configured default effort). */
  settings?: SessionSettings;
}

export class AgentSession {
  readonly id: string;
  readonly channel: string;
  readonly userId: string | undefined;
  readonly userRole: string | undefined;
  readonly createdAt: Date;

  private history: SessionHistoryMessage[] = [];
  private systemPrompt: string;
  private workspacePath: string;
  private turnCount = 0;
  private updatedAt: Date;
  private archivedAt?: Date;
  /** Why this session was archived. "idle" = auto-archived by the idle sweep (a real
   *  user conversation that went quiet — kept on the long idle-retention, never the
   *  short ephemera TTL). "timeout" = the gateway turn watchdog fired mid-turn (same
   *  retention as idle, and resumable — the partial work is still in history).
   *  "manual" = explicit user/system archival or ephemeral scene/job/workflow-worker
   *  cleanup (reclaimed on gateway.sessionTtlMs). */
  private archivedReason?: ArchivedReason;
  private endLogged = false;
  /** Serialised byte length of the tool schemas sent to the LLM for the current turn.
   *  Updated by the runtime each turn before the LLM loop starts so
   *  maybeTrimHistory accounts for the full actual prompt size. */
  private toolSchemasChars = 0;
  /** Context window (in tokens) of the model actually running this session's
   *  turns. Set by the runtime each turn from the resolved provider model so the
   *  trimmer budgets against the real window rather than the global default. */
  private contextWindowTokens?: number;
  /** Rolling, deterministic digest of conversation turns that were trimmed out
   *  of the live window. Folded back into the prompt as a leading system note so
   *  long-horizon tasks keep the gist of earlier context (and the original
   *  request, which is pinned verbatim) instead of silently losing it. */
  private earlierSummary = "";
  /** Per-session effort/time-limit settings (composer-controlled, persisted). */
  private settings: SessionSettings = {};

  constructor(opts: AgentSessionOptions & {
    createdAt?: Date;
    updatedAt?: Date;
    archivedAt?: Date;
    archivedReason?: ArchivedReason;
    turnCount?: number;
    history?: SessionHistoryMessage[];
    earlierSummary?: string;
  }) {
    this.id = opts.sessionId ?? randomUUID();
    this.channel = opts.channel;
    this.userId = opts.userId;
    this.userRole = opts.userRole;
    this.createdAt = opts.createdAt ?? new Date();
    // THE ROOT IS THE USER'S. Everything a turn does with files hangs off this — the
    // orchestrator's own tools, every delegated sub-agent, artifact collection, the probe — so
    // partitioning HERE keeps one turn's work in one place. Config zones and the deployment's
    // own state stay at the shared root, which the two workspaceAccess:"full" agents keep (see
    // agent/sub-agent.ts) and which the config loader always reads directly.
    this.workspacePath = userWorkspaceRoot(opts.workspacePath ?? getConfig().workspacePath, opts.userId);
    this.systemPrompt = opts.systemPrompt ?? defaultSystemPrompt(this.workspacePath);
    this.updatedAt = opts.updatedAt ?? this.createdAt;
    this.archivedAt = opts.archivedAt;
    this.archivedReason = opts.archivedReason;
    this.turnCount = opts.turnCount ?? 0;
    this.history = opts.history ? [...opts.history] : [];
    this.earlierSummary = opts.earlierSummary ?? "";
    this.settings = opts.settings ? { ...opts.settings } : {};
    this.endLogged = Boolean(this.archivedAt);

    if (!opts.createdAt) {
      logAudit("session_created", { channel: opts.channel, workspacePath: this.workspacePath }, {
        sessionId: this.id,
        userId: opts.userId,
        channel: opts.channel,
      });
      log.info({ sessionId: this.id, channel: opts.channel }, "Session created");
    }
  }

  static fromRecord(record: PersistedSessionRecord): AgentSession {
    return new AgentSession({
      sessionId: record.id,
      channel: record.channel,
      userId: record.userId,
      userRole: record.userRole,
      systemPrompt: record.systemPrompt,
      workspacePath: record.workspacePath,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      archivedAt: record.archivedAt ? new Date(record.archivedAt) : undefined,
      archivedReason: record.archivedReason,
      turnCount: record.turnCount,
      history: record.history,
      earlierSummary: record.earlierSummary,
      settings: record.settings,
    });
  }

  getHistory(): readonly SessionHistoryMessage[] {
    return this.history;
  }

  getUpdatedAt(): Date {
    return this.updatedAt;
  }

  getArchivedAt(): Date | undefined {
    return this.archivedAt;
  }

  isArchived(): boolean {
    return Boolean(this.archivedAt);
  }

  /**
   * Returns a compacted view of history where assistant tool_calls + tool results
   * are collapsed into plain text summaries.  Feeding this to the LLM instead of
   * the raw structured form prevents the model from learning to hallucinate tool
   * call syntax by pattern-matching its own previous responses.
   */
  getCollapsedHistory(): LLMMessage[] {
    const collapsed: LLMMessage[] = [];
    // Fold the rolling digest of trimmed-out turns back in as a leading system
    // note so the model retains earlier context (and the pinned original
    // request) after older raw messages have been dropped from the window.
    if (this.earlierSummary) {
      collapsed.push({ role: "system", content: this.earlierSummary });
    }
    // The plan report's 12K allowance is for the turn that is answering from it. Once that turn
    // is over the report is history like any other delegation result — held at the delegation
    // cap, not carried in full into every later turn's prompt.
    let currentTurnStart = -1;
    for (let k = this.history.length - 1; k >= 0; k -= 1) {
      if (this.history[k]!.role === "user") { currentTurnStart = k; break; }
    }
    let i = 0;
    while (i < this.history.length) {
      const msg = this.history[i]!;

      // Detect an assistant message that contains tool_calls
      const tc = (msg as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls;
      if (msg.role === "assistant" && Array.isArray(tc) && tc.length > 0) {
        // Collect the following tool-result messages for these call IDs
        const resultMap = new Map<string, string>();
        let j = i + 1;
        while (j < this.history.length && this.history[j]!.role === "tool") {
          const r = this.history[j]! as { role: "tool"; content: string; tool_call_id?: string };
          if (r.tool_call_id) resultMap.set(r.tool_call_id, r.content);
          j++;
        }

        // Build a concise text summary replacing the raw JSON block
        const summaryLines = tc.map(call => {
          let argsStr = call.function.arguments;
          try {
            const parsed = JSON.parse(argsStr) as Record<string, unknown>;
            argsStr = Object.entries(parsed)
              .map(([k, v]) => `${k}: ${String(v).substring(0, 80)}`)
              .join(", ");
          } catch { /* leave raw */ }
          const result = resultMap.get(call.id) ?? "(no result)";
          // Delegation results carry sub-agent evidence that the orchestrator must
          // relay faithfully.  A 500-char cap truncated evidence and caused
          // hallucinations.  Use 2000 chars for delegation results, 500 for others.
          const isDelegation = /^(delegate_to_agent|parallel_delegate|create_ephemeral_agent|run_task_graph|run_workflow)$/.test(call.function.name);
          // execute_plan's result stands in for a WHOLE PLAN — every step's evidence at once, and
          // the only channel a `direct` or `reuse` step's output has, since those run as nested
          // calls that never become tool messages of their own. At the delegation cap it lost every
          // step after the first; at the default 500 it lost the first one too, along with the
          // instruction to synthesize from them. It is the collapsed view that the answer-writing
          // iteration reads, so this is the number that decides what the answer can be based on.
          const snippetLimit = call.function.name === "execute_plan"
            ? (i > currentTurnStart ? 12000 : 2000)
            : (isDelegation ? 2000 : 500);
          // Use an explicit marker instead of a bare ellipsis. Local models
          // sometimes mistake "…" for evidence that was cut off in the
          // current turn and then falsely claim "abgeschnitten" /
          // "truncated" in their synthesis. Naming the condition removes
          // the ambiguity. (Source: hallucinated_truncation_bypass events.)
          const resultSnippet = result.length > snippetLimit
            ? result.substring(0, snippetLimit) + ` [snippet summarized for prior-turn history; full result preserved in the original tool call above, ${result.length} chars total]`
            : result;
          return `[Tool: ${call.function.name}(${argsStr}) → ${resultSnippet}]`;
        });

        const summaryText = (msg.content ? msg.content + "\n" : "") + summaryLines.join("\n");
        const last = collapsed[collapsed.length - 1];

        // End the prompt on a user turn after tool execution. Many OpenAI-compatible
        // runtimes answer with an empty stop response if the last message is assistant.
        if (last?.role === "user") {
          last.content = [last.content, summaryText].filter(Boolean).join("\n\n");
        } else {
          collapsed.push({
            role: "user",
            content: `Tool results for the current request:\n${summaryText}`,
          });
        }
        i = j; // skip past the tool-result messages
        continue;
      }

      // Skip orphaned tool-result messages (shouldn't happen, but guard anyway)
      if (msg.role === "tool") {
        i++;
        continue;
      }

      collapsed.push({ role: msg.role, content: msg.content ?? "" });
      i++;
    }

    // Merge consecutive assistant messages — two adjacent assistant turns confuse the model
    // into thinking the conversation is concluded, producing an empty stop response.
    const merged: LLMMessage[] = [];
    for (const msg of collapsed) {
      const last = merged[merged.length - 1];
      if (last && last.role === "assistant" && msg.role === "assistant") {
        last.content = (typeof last.content === "string" ? last.content : "") + "\n" + (typeof msg.content === "string" ? msg.content : "");
      } else {
        merged.push({ ...msg });
      }
    }

    return merged;
  }

  getSystemPrompt(): string {
    const prompt = isManagedDefaultSystemPrompt(this.systemPrompt)
      ? defaultSystemPrompt(this.workspacePath)
      : this.systemPrompt;
    return refreshTemporalContext(prompt);
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  addMessage(msg: LLMMessage & { metadata?: Record<string, unknown> }): void {
    this.history.push(withTimestamp(msg));
    this.touch();
    this.maybeTrimHistory();
    persistSessionStore(this);
  }

  addMessages(msgs: Array<LLMMessage & { metadata?: Record<string, unknown> }>): void {
    this.history.push(...msgs.map(withTimestamp));
    this.touch();
    this.maybeTrimHistory();
    persistSessionStore(this);
  }

  /**
   * Whether a transient system note with this prefix is already on the current turn (after the
   * last user message). The per-iteration guidance notes are meant to be stated once per turn;
   * appended after every tool round they compounded — five copies of the same ownership note in
   * one turn's history, all re-sent on every iteration.
   */
  hasTransientNoteThisTurn(prefix: string): boolean {
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const message = this.history[index]!;
      if (message.role === "user") return false;
      if (message.role === "system" && typeof message.content === "string" && message.content.startsWith(prefix)) return true;
    }
    return false;
  }

  pruneTransientTurnSystemMessages(): void {
    if (this.history.length === 0) return;

    const kept: SessionHistoryMessage[] = [];
    let sawLaterUserMessage = false;

    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const message = this.history[index]!;
      const isTransientSystem = isTransientTurnSystemMessage(message);

      if (message.role === "user") {
        sawLaterUserMessage = true;
      }

      if (isTransientSystem && sawLaterUserMessage) {
        continue;
      }

      kept.push(message);
    }

    if (kept.length === this.history.length) return;

    this.history = kept.reverse();
    this.touch();
    persistSessionStore(this);
  }

  incrementTurn(): void {
    this.turnCount++;
    this.touch();
    persistSessionStore(this);
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  /** Call once per turn, after tool definitions are resolved, so the history
   *  trimmer accounts for the full prompt size (system + tools + history). */
  setToolSchemasChars(chars: number): void {
    this.toolSchemasChars = Math.max(0, chars);
  }

  /** Tool-schema payload size for this turn, for telemetry (not part of promptChars). */
  getToolSchemasChars(): number {
    return this.toolSchemasChars;
  }

  /** Tell the session the context window (tokens) of the model running its
   *  turns, so the trimmer budgets against the real window. */
  setContextWindow(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.contextWindowTokens = Math.floor(tokens);
  }

  private effectiveContextWindow(): number {
    return this.contextWindowTokens ?? getConfig().agents.defaults.model.contextWindow;
  }

  reset(): void {
    this.history = [];
    this.turnCount = 0;
    this.touch();
    logAudit("session_reset", { reason: "manual_reset" }, { sessionId: this.id });
    persistSessionStore(this);
  }

  /**
   * Truncate history so that `this.history[historyIndex]` and everything after it
   * is removed.  Keeps indices 0 … historyIndex-1 (exclusive).  Used to rewind
   * the conversation to just before a specific message so the user can branch off
   * from that point.
   */
  rewindBeforeIndex(historyIndex: number): void {
    const clamped = Math.max(0, Math.min(historyIndex, this.history.length));
    if (clamped === this.history.length) return; // nothing to remove
    this.history = this.history.slice(0, clamped);
    this.touch();
    logAudit("session_rewound", { historyIndex: clamped, remaining: this.history.length }, { sessionId: this.id });
    persistSessionStore(this);
  }

  end(): void {
    if (this.endLogged) return;
    this.endLogged = true;
    logAudit("session_ended", { turnCount: this.turnCount }, {
      sessionId: this.id,
      userId: this.userId,
      channel: this.channel,
    });
    log.info({ sessionId: this.id, turns: this.turnCount }, "Session ended");
  }

  getArchivedReason(): ArchivedReason | undefined {
    return this.archivedReason;
  }

  archive(reason: ArchivedReason = "manual"): void {
    if (this.archivedAt) return;
    this.archivedAt = new Date();
    this.archivedReason = reason;
    this.touch(this.archivedAt);
    this.end();
    persistSessionStore(this);
  }

  /**
   * Un-park a session archived for a RESUMABLE reason (timeout/idle) so a follow-up
   * message continues this conversation. History, turn count and settings are left
   * untouched — that is the point: the timed-out turn's recovered delivery message
   * and the tool messages carrying its partial artifacts stay in context for the
   * continuation. Returns false for a live session or an explicit ("manual") archive.
   */
  reactivate(): boolean {
    if (!this.archivedAt || !isResumableArchive(this.archivedReason)) return false;
    const reason = this.archivedReason;
    this.archivedAt = undefined;
    this.archivedReason = undefined;
    // The session is live again, so a later real end must log session_ended again.
    this.endLogged = false;
    this.touch();
    persistSessionStore(this);
    // Dotted extension event type — the counterpart to session_ended, without widening
    // the core audit enum. Makes "was this the same conversation?" answerable from the
    // audit log, which is exactly what was unanswerable when a timeout looked terminal.
    logAudit("session.resumed", { reason, turnCount: this.turnCount, messageCount: this.history.length }, {
      sessionId: this.id,
      userId: this.userId,
      channel: this.channel,
    });
    log.info({ sessionId: this.id, reason }, "Resumed archived session");
    return true;
  }

  toRecord(): PersistedSessionRecord {
    return {
      id: this.id,
      channel: this.channel,
      userId: this.userId,
      ...(this.userRole ? { userRole: this.userRole } : {}),
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      archivedAt: this.archivedAt?.toISOString(),
      ...(this.archivedReason ? { archivedReason: this.archivedReason } : {}),
      systemPrompt: this.systemPrompt,
      workspacePath: this.workspacePath,
      turnCount: this.turnCount,
      history: this.history.map((message) => ({ ...message })),
      ...(this.earlierSummary ? { earlierSummary: this.earlierSummary } : {}),
      ...(Object.keys(this.settings).length ? { settings: { ...this.settings } } : {}),
    };
  }

  /** Per-session effort/time-limit settings (composer-controlled). */
  getSettings(): SessionSettings {
    return { ...this.settings };
  }

  /**
   * Patch the session settings. Keys set to `undefined` are removed (reset to the
   * configured default). Touches updatedAt and persists.
   */
  setSettings(patch: Partial<SessionSettings>): SessionSettings {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (this.settings as Record<string, unknown>)[key];
      else (this.settings as Record<string, unknown>)[key] = value;
    }
    this.touch();
    persistSessionStore(this);
    return this.getSettings();
  }

  toSummary(): SessionSummary {
    const previewSource = [...this.history].reverse().find((message) =>
      (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.trim().length > 0,
    );
    const preview = previewSource
      ? sanitizeTranscriptContent(
          previewSource.role,
          previewSource.content,
          Array.isArray((previewSource as { tool_calls?: unknown[] }).tool_calls) && (((previewSource as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0),
        )
      : undefined;

    return {
      id: this.id,
      channel: this.channel,
      userId: this.userId,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      archivedAt: this.archivedAt?.toISOString(),
      turns: this.turnCount,
      messageCount: this.history.length,
      lastMessageAt: this.history.at(-1)?.timestamp,
      preview: preview ? preview.slice(0, 160) : undefined,
    };
  }

  toTranscript(): SessionTranscriptMessage[] {
    const raw: SessionTranscriptMessage[] = [];
    let index = 0;

    while (index < this.history.length) {
      const message = this.history[index]!;
      if (message.role === "tool") {
        index += 1;
        continue;
      }

      if (isTransientTurnSystemMessage(message)) {
        index += 1;
        continue;
      }

      if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const results = new Map<string, string>();
        const metadataByCallId = new Map<string, Record<string, unknown>>();
        let cursor = index + 1;
        while (cursor < this.history.length && this.history[cursor]?.role === "tool") {
          const toolMessage = this.history[cursor]!;
          if (toolMessage.tool_call_id) results.set(toolMessage.tool_call_id, toolMessage.content ?? "");
          if (toolMessage.tool_call_id && toolMessage.metadata && typeof toolMessage.metadata === "object") {
            metadataByCallId.set(toolMessage.tool_call_id, toolMessage.metadata);
          }
          cursor += 1;
        }

        raw.push({
          id: `${this.id}:${index}`,
          role: "assistant",
          content: sanitizeTranscriptContent("assistant", message.content ?? "", true),
          timestamp: message.timestamp,
          swarmState: getTranscriptSwarmState(message.metadata),
          toolCalls: message.tool_calls.map((toolCall) => {
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
            } catch {
              args = { raw: toolCall.function.arguments };
            }
            return {
              name: toolCall.function.name,
              args,
              result: results.get(toolCall.id),
              metadata: metadataByCallId.get(toolCall.id),
            };
          }),
        });
        index = cursor;
        continue;
      }

      const transcriptContent = getTranscriptDisplayContent(message);
      const attachments = getTranscriptAttachments(message.metadata);
      raw.push({
        id: `${this.id}:${index}`,
        role: message.role,
        content: transcriptContent,
        timestamp: message.timestamp,
        attachments,
        swarmState: message.role === "assistant" ? getTranscriptSwarmState(message.metadata) : undefined,
      });
      index += 1;
    }

    // Merge consecutive assistant entries that belong to the same turn.
    // During a multi-iteration tool-use turn the history contains several
    // assistant messages (one per LLM call) interleaved with tool results.
    // The live UI shows them as one message — replicate that on reload.
    const transcript: SessionTranscriptMessage[] = [];
    for (const entry of raw) {
      const prev = transcript[transcript.length - 1];
      if (prev && prev.role === "assistant" && entry.role === "assistant") {
        // Combine tool calls
        if (entry.toolCalls?.length) {
          prev.toolCalls = [...(prev.toolCalls ?? []), ...entry.toolCalls];
        }
        if (entry.swarmState) {
          prev.swarmState = entry.swarmState;
        }
        // Keep the last non-empty content (the final synthesis text)
        if (entry.content) {
          prev.content = entry.content;
        }
      } else {
        transcript.push({ ...entry });
      }
    }

    return transcript;
  }

  private maybeTrimHistory(): void {
    // The completion budget is DERIVED from what the prompt leaves free
    // (providers/lmstudio.ts computeOutputTokenBudget), so this trimmer's job is to
    // guarantee a usable output budget always remains. A flat 0.75 could not: at
    // contextWindow 32768 it left 8,192 tokens free, of which the provider's own 8%
    // reserve takes 2,622 — less output headroom than the reservation implies.
    //
    // The bound AND the estimator now come from the provider module, because the
    // provider re-measures this same text before deriving max_tokens: a local
    // chars/4 count against the provider's chars/3.0 meant the "reserved" headroom
    // was never the number this file claimed. One estimator, one unit, one bound —
    // shared with the sub-agent trimmer (agent/sub-agent-history.ts).
    const contextWindow = this.effectiveContextWindow();
    const maxTokenEstimate = computePromptTokenBudget(contextWindow);
    if (estimatePromptTokens(this.systemPrompt, this.getCollapsedHistory(), this.toolSchemasChars) <= maxTokenEstimate || this.history.length <= 6) return;

    const minKeep = 6; // always keep at least the last 6 messages
    // Pin the original request (first user message) verbatim — it carries the
    // task's requirements and acceptance criteria, which are exactly what a
    // long-horizon turn must not lose. Everything dropped between the pin and
    // the kept tail is folded into the rolling digest instead of discarded.
    const pinnedHead = this.history[0]?.role === "user" ? 1 : 0;
    let droppedTotal = 0;

    while (this.history.length > minKeep && estimatePromptTokens(this.systemPrompt, this.getCollapsedHistory(), this.toolSchemasChars) > maxTokenEstimate) {
      const maxDropEnd = this.history.length - minKeep;
      let safeCut = pinnedHead;

      for (let i = pinnedHead; i < maxDropEnd; i++) {
        const msg = this.history[i];
        const next = this.history[i + 1];
        if (!msg || !next) break;

        const msgHasToolCalls = msg.role === "assistant" && Array.isArray((msg as { tool_calls?: unknown[] }).tool_calls) && ((msg as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0;
        const nextIsToolResult = next.role === "tool";

        if (!msgHasToolCalls && !nextIsToolResult) {
          safeCut = i + 1;
        }
      }

      if (safeCut <= pinnedHead) break;
      const dropped = this.history.splice(pinnedHead, safeCut - pinnedHead);
      this.foldIntoEarlierSummary(dropped);
      droppedTotal += dropped.length;
    }

    if (droppedTotal > 0) {
      this.touch();
      persistSessionStore(this);
      logAudit("history_compacted", {
        dropped: droppedTotal,
        remaining: this.history.length,
        summaryChars: this.earlierSummary.length,
      }, { sessionId: this.id, severity: "info" });
      log.debug({ sessionId: this.id, dropped: droppedTotal, remaining: this.history.length, summaryChars: this.earlierSummary.length }, "Compacted history for context window");
    }
  }

  /** Append a deterministic digest of the dropped messages to the rolling
   *  summary, bounded so the digest itself can never dominate the window. */
  private foldIntoEarlierSummary(dropped: SessionHistoryMessage[]): void {
    const lines = dropped.flatMap((msg) => digestHistoryMessage(msg));
    if (lines.length === 0) return;

    const body = (this.earlierSummary ? this.earlierSummary.replace(SUMMARY_HEADER + "\n", "") : "")
      .split("\n").filter(Boolean)
      .concat(lines);

    // Cap the digest body. When over budget, drop the OLDEST digest lines and
    // mark the elision — recent context is the most useful for continuing.
    const kept = body;
    let elided = 0;
    while (kept.join("\n").length > MAX_EARLIER_SUMMARY_CHARS && kept.length > 1) {
      kept.shift();
      elided += 1;
    }
    const elisionNote = elided > 0 ? [`• … ${elided} earlier item(s) condensed away`] : [];
    this.earlierSummary = [SUMMARY_HEADER, ...elisionNote, ...kept].join("\n");
  }

  private touch(date = new Date()): void {
    this.updatedAt = date;
  }
}

const SUMMARY_HEADER = "[EARLIER CONVERSATION — condensed because older turns no longer fit the context window. Treat as background; the original request is preserved verbatim in the conversation below.]";
const MAX_EARLIER_SUMMARY_CHARS = 3_000;

/** Build a compact, deterministic one-liner (or none) for a trimmed message.
 *  Raw tool-result messages are skipped — their essence is captured by the
 *  "called <tool>" note on the assistant message that issued them. */
function digestHistoryMessage(msg: SessionHistoryMessage): string[] {
  if (msg.role === "tool") return [];

  const toolCalls = (msg as { tool_calls?: Array<{ function: { name: string } }> }).tool_calls;
  const text = typeof msg.content === "string" ? msg.content.replace(/\s+/g, " ").trim() : "";

  if (msg.role === "assistant" && Array.isArray(toolCalls) && toolCalls.length > 0) {
    const names = [...new Set(toolCalls.map((call) => call.function?.name).filter(Boolean))].join(", ");
    const note = text ? `: ${text.slice(0, 160)}` : "";
    return [`• assistant called ${names}${note}`];
  }

  if (!text) return [];
  const label = msg.role === "user" ? "user" : "assistant";
  return [`• ${label}: ${text.slice(0, 220)}`];
}

/** Measured in the SAME unit the provider uses to derive max_tokens
 *  (providers/lmstudio.ts PROMPT_ESTIMATE_CHARS_PER_TOKEN + per-message framing).
 *  It used to be a private chars/4 count, so the headroom this trimmer reserved and
 *  the headroom the provider actually found were different numbers — the trimmer
 *  under-counted the prompt by ~25% and the provider's derived budget collapsed
 *  accordingly. `estimatePromptTokensForRequest` also counts tool_call arguments,
 *  which the old reducer ignored entirely. */
function estimatePromptTokens(systemPrompt: string, history: readonly LLMMessage[], toolSchemasChars = 0): number {
  const fixedChars = systemPrompt.length + toolSchemasChars;
  return Math.ceil(fixedChars / PROMPT_ESTIMATE_CHARS_PER_TOKEN)
    + estimatePromptTokensForRequest(history);
}

function getTranscriptDisplayContent(message: SessionHistoryMessage): string {
  if (message.role === "user") {
    const displayContent = message.metadata?.["displayContent"];
    if (typeof displayContent === "string" && displayContent.trim()) {
      return sanitizeTranscriptContent("user", displayContent, false);
    }
  }
  return sanitizeTranscriptContent(message.role, message.content ?? "", false);
}

function getTranscriptAttachments(metadata?: Record<string, unknown>): SessionTranscriptAttachment[] | undefined {
  const raw = metadata?.["attachments"];
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

function getTranscriptSwarmState(metadata?: Record<string, unknown>): SwarmState | undefined {
  const raw = metadata?.["swarmState"];
  if (!raw || typeof raw !== "object") return undefined;
  return structuredClone(raw as SwarmState);
}

const _sessions = new Map<string, AgentSession>();
const SESSION_STORE_PATH = resolveSessionStorePath();

loadPersistedSessions();

export function createSession(opts: AgentSessionOptions & { createdAt?: Date; updatedAt?: Date }): AgentSession {
  if (opts.sessionId) {
    const existing = _sessions.get(opts.sessionId);
    if (existing && !existing.isArchived()) {
      return existing;
    }
  }

  // Seed the effort tier from the configured global default when the caller did
  // not specify one, so new sessions inherit the operator's chosen baseline.
  const seededOpts: AgentSessionOptions & { createdAt?: Date; updatedAt?: Date } = opts.settings?.effort
    ? opts
    : { ...opts, settings: { ...opts.settings, effort: getConfig().effort?.default ?? "medium" } };

  const session = new AgentSession(seededOpts);
  _sessions.set(session.id, session);
  persistSessionStore(session);

  // Soft observability: surface when live session load exceeds the configured
  // concurrency advisory (agents.rateLimit.concurrentSessions). Deliberately a
  // non-blocking SIGNAL, not a hard cap — a hard cap would break legitimate
  // multi-tab / multi-channel use; operators watch the warning to size capacity.
  const concurrencyAdvisory = getConfig().agents?.rateLimit?.concurrentSessions;
  if (concurrencyAdvisory && concurrencyAdvisory > 0) {
    const activeSessions = [..._sessions.values()].filter((s) => !s.isArchived()).length;
    if (activeSessions > concurrencyAdvisory) {
      log.warn({ activeSessions, advisory: concurrencyAdvisory, sessionId: session.id },
        "Active session count exceeds the concurrentSessions advisory");
    }
  }
  return session;
}

export function getSession(id: string): AgentSession | undefined {
  const session = _sessions.get(id);
  if (!session || session.isArchived()) return undefined;
  return session;
}

export function getSessionRecord(id: string): AgentSession | undefined {
  return _sessions.get(id);
}

export function archiveSession(id: string, reason: ArchivedReason = "manual"): boolean {
  const session = _sessions.get(id);
  if (!session || session.isArchived()) return false;
  session.archive(reason);
  // Fire-and-forget: harvest durable-worthy session facts into long-term
  // workspace memory before the session's short-term facts age out. Dynamic
  // import keeps the memory layer out of the session module's load graph.
  void (async () => {
    try {
      const { consolidateSessionMemory } = await import("../memory/session-consolidation.js");
      await consolidateSessionMemory({
        sessionId: session.id,
        workspacePath: session.getWorkspacePath(),
        channel: session.channel,
        turnCount: session.getTurnCount(),
      });
    } catch { /* best-effort — never block archival */ }
  })();
  return true;
}

/** Why a session id is no longer in the store. Kept in a small ring so "not found"
 *  can say WHICH benign thing happened instead of implying the id never existed. */
export type SessionRemovalReason = "deleted" | "pruned";
const REMOVAL_LEDGER_LIMIT = 500;
const _removedSessions = new Map<string, SessionRemovalReason>();

function recordSessionRemoval(id: string, reason: SessionRemovalReason): void {
  _removedSessions.delete(id);
  _removedSessions.set(id, reason);
  while (_removedSessions.size > REMOVAL_LEDGER_LIMIT) {
    const oldest = _removedSessions.keys().next();
    if (oldest.done) break;
    _removedSessions.delete(oldest.value);
  }
}

/**
 * Honest explanation for a session id this gateway cannot serve, for the "Session
 * not found" surfaces. A missing id has several benign causes that used to be
 * indistinguishable to the user: it aged out of retention, it was deleted, or this
 * process simply never saw it (a restart with no persisted store, or another
 * gateway instance owns it). Ownership denials deliberately do NOT come here —
 * those stay opaque so an id cannot be probed for existence.
 */
export function describeMissingSession(id: string): string {
  const removed = _removedSessions.get(id);
  if (removed === "pruned") return "it aged out of the retention window and was pruned";
  if (removed === "deleted") return "it was deleted";
  const record = _sessions.get(id);
  if (record?.isArchived()) return `it was archived (${record.getArchivedReason() ?? "manual"}) and cannot be resumed`;
  return "this gateway has no record of it — it may belong to another instance or predate a restart";
}

export function deleteSession(id: string, reason: SessionRemovalReason = "deleted"): boolean {
  const session = _sessions.get(id);
  if (!session) return false;
  session.end();
  _sessions.delete(id);
  recordSessionRemoval(id, reason);
  persistSessionStore();
  void deleteSessionFromRedis(id);
  return true;
}

export function endSession(id: string): void {
  deleteSession(id);
}

export function getAllSessions(opts?: { includeArchived?: boolean }): AgentSession[] {
  return [..._sessions.values()]
    .filter((session) => opts?.includeArchived || !session.isArchived())
    .sort((left, right) => right.getUpdatedAt().getTime() - left.getUpdatedAt().getTime());
}

// ── Archived-session pruning ────────────────────────────────────────────────
// Sessions persist (in-process + Redis) and accumulate forever once archived,
// which is an unbounded resource leak on a long-lived gateway. The pruner
// deletes ARCHIVED sessions whose archive timestamp is older than the configured
// TTL (gateway.sessionTtlMs), on a fixed interval (agents.sessionPruneIntervalMs).
// Active sessions are never touched. Wired from the gateway boot path.

let _sessionPrunerTimer: ReturnType<typeof setInterval> | null = null;

/** Delete archived sessions past their retention. Two classes with separate windows:
 *  ephemeral/explicitly-archived sessions (scene/job/workflow workers, one-shots, user
 *  archive) age out on the short `ttlMs` (gateway.sessionTtlMs), while RESUMABLE archives
 *  — idle-swept and turn-timed-out real user conversations — use the generous
 *  `idleRetentionMs` (agents.sessionIdleRetentionMs;
 *  0 = keep indefinitely) so a chat merely idle for a day is NOT permanently deleted an
 *  hour later. Active sessions are never pruned. A non-positive window disables that
 *  class. Returns the number deleted. */
export function pruneArchivedSessions(ttlMs: number, idleRetentionMs = 0): number {
  const now = Date.now();
  let pruned = 0;
  for (const session of [..._sessions.values()]) {
    if (!session.isArchived()) continue;
    const archivedAt = session.getArchivedAt()?.getTime();
    if (archivedAt === undefined) continue;
    // Resumable archives (idle sweep, turn timeout) are real user conversations that
    // still hold their work — they get the generous idle retention, never the short
    // ephemera TTL that reclaims scene/job workers.
    const retention = isResumableArchive(session.getArchivedReason()) ? idleRetentionMs : ttlMs;
    if (!(retention > 0)) continue; // this class's retention is disabled (keep forever)
    if (archivedAt < now - retention) {
      deleteSession(session.id, "pruned");
      pruned += 1;
    }
  }
  if (pruned > 0) log.info({ pruned, ttlMs, idleRetentionMs }, "Pruned aged archived sessions");
  return pruned;
}

/** Archive still-active sessions with no activity for longer than `idleMs` so they drop
 *  out of the hot active set. Marked "idle" so the pruner keeps them on the generous
 *  idle-retention (a real conversation), NOT the short ephemera TTL. A live turn keeps
 *  the session fresh via touch() and is capped well under the (generous) idle window, so
 *  it is never mistaken for idle. A non-positive idleMs disables this. Returns the number
 *  archived. */
export function archiveIdleSessions(idleMs: number): number {
  if (!(idleMs > 0)) return 0;
  const cutoff = Date.now() - idleMs;
  let archived = 0;
  for (const session of [..._sessions.values()]) {
    if (session.isArchived()) continue;
    if (session.getUpdatedAt().getTime() < cutoff) {
      archiveSession(session.id, "idle");
      archived += 1;
    }
  }
  if (archived > 0) log.info({ archived, idleMs }, "Archived idle sessions");
  return archived;
}

/** Start the periodic archived-session pruner (idempotent). Interval + TTLs come
 *  from agents.sessionPruneIntervalMs, gateway.sessionTtlMs, and
 *  agents.sessionIdleArchiveMs. */
export function startSessionPruner(): void {
  if (_sessionPrunerTimer) return;
  const config = getConfig();
  const intervalMs = config.agents?.sessionPruneIntervalMs ?? 60_000;
  const ttlMs = config.gateway?.sessionTtlMs ?? 3_600_000;
  const idleArchiveMs = config.agents?.sessionIdleArchiveMs ?? 86_400_000;
  const idleRetentionMs = config.agents?.sessionIdleRetentionMs ?? 0;
  _sessionPrunerTimer = setInterval(() => {
    try {
      archiveIdleSessions(idleArchiveMs);          // idle active user chats → archived (kept)
      pruneArchivedSessions(ttlMs, idleRetentionMs); // aged EPHEMERAL archives → deleted; idle chats kept per idleRetentionMs
    } catch (err) { log.warn({ err }, "session pruner tick failed"); }
  }, intervalMs);
  _sessionPrunerTimer.unref?.();
  log.info({ intervalMs, ttlMs }, "Session pruner started");
}

/** Stop the periodic pruner (used on shutdown and in tests). */
export function stopSessionPruner(): void {
  if (_sessionPrunerTimer) {
    clearInterval(_sessionPrunerTimer);
    _sessionPrunerTimer = null;
  }
}

/**
 * Async session lookup with Redis fallback.
 *
 * Tries the in-process cache first; if the session is not found locally
 * (e.g. the client was routed to a different gateway instance last time),
 * fetches and hydrates it from Redis.
 *
 * Returns `undefined` when the session does not exist anywhere or is archived.
 *
 * `resumeArchived` widens that last clause for the CONTINUE path: a session parked by
 * the turn watchdog or the idle sweep is un-parked in place and returned, so a
 * follow-up message lands on the same history (including the partial work the timed-out
 * turn preserved). Explicitly ("manual") archived sessions still resolve to undefined.
 */
export async function resolveSession(
  id: string,
  opts?: { resumeArchived?: boolean },
): Promise<AgentSession | undefined> {
  const local = _sessions.get(id);
  if (local && !local.isArchived()) return local;
  if (local && opts?.resumeArchived) return local.reactivate() ? local : undefined;

  const raw = await loadSessionFromRedis(id);
  if (!raw) return undefined;

  try {
    const record = JSON.parse(raw) as PersistedSessionRecord;
    const session = AgentSession.fromRecord(record);
    if (session.isArchived()) {
      if (!opts?.resumeArchived) return undefined;
      // Hydrate first so the un-park is persisted against the live store entry.
      _sessions.set(session.id, session);
      if (session.reactivate()) return session;
      _sessions.delete(session.id); // explicit archive — leave the cache as we found it
      return undefined;
    }
    _sessions.set(session.id, session);
    return session;
  } catch (err) {
    log.warn({ err, sessionId: id }, "Failed to hydrate session from Redis");
    return undefined;
  }
}

/**
 * Seed the in-process session cache from Redis on startup.
 *
 * Must be called after the REDIS_URL env var is available.  Sessions already
 * loaded from the JSON file are merged: the entry with the newer `updatedAt
 * wins.
 */
export async function initSessionRedis(): Promise<void> {
  const raws = await loadAllSessionsFromRedis();
  if (!raws.length) return;

  let loaded = 0;
  for (const raw of raws) {
    try {
      const record = JSON.parse(raw) as PersistedSessionRecord;
      const existing = _sessions.get(record.id);
      const recordUpdatedAt = new Date(record.updatedAt).getTime();
      const existingUpdatedAt = existing?.getUpdatedAt().getTime() ?? 0;
      if (!existing || recordUpdatedAt > existingUpdatedAt) {
        _sessions.set(record.id, AgentSession.fromRecord(record));
        loaded++;
      }
    } catch (err) {
      log.warn({ err }, "Failed to hydrate session from Redis during init");
    }
  }

  if (loaded > 0) {
    log.info({ loaded }, "Seeded sessions from Redis");
  }
}

export function listSessions(opts?: { includeArchived?: boolean }): SessionSummary[] {
  return getAllSessions(opts).map((session) => session.toSummary());
}

export function getSessionTranscript(id: string, opts?: { limit?: number; beforeMessageId?: string }): SessionTranscriptPage | undefined {
  const session = _sessions.get(id);
  if (!session) return undefined;
  const transcript = session.toTranscript();
  const totalMessages = transcript.length;
  const limit = normalizeTranscriptLimit(opts?.limit);

  let endExclusive = transcript.length;
  if (opts?.beforeMessageId) {
    const beforeIndex = transcript.findIndex((message) => message.id === opts.beforeMessageId);
    if (beforeIndex >= 0) {
      endExclusive = beforeIndex;
    }
  }

  const start = limit ? Math.max(0, endExclusive - limit) : 0;
  const page = transcript.slice(start, endExclusive);

  return {
    session: session.toSummary(),
    transcript: page,
    totalMessages,
    nextBeforeMessageId: start > 0 && page.length > 0 ? page[0]!.id : undefined,
  };
}

export function resetSessionsForTests(): void {
  _sessions.clear();
  persistSessionStore();
}

function withTimestamp(message: LLMMessage & { metadata?: Record<string, unknown> }): SessionHistoryMessage {
  return {
    ...message,
    timestamp: new Date().toISOString(),
  };
}

function loadPersistedSessions(): void {
  if (!existsSync(SESSION_STORE_PATH)) return;

  try {
    const raw = JSON.parse(readFileSync(SESSION_STORE_PATH, "utf8")) as { sessions?: PersistedSessionRecord[] };
    for (const record of raw.sessions ?? []) {
      const session = AgentSession.fromRecord(record);
      _sessions.set(session.id, session);
    }
  } catch (err) {
    log.error({ err, path: SESSION_STORE_PATH }, "Failed to load persisted sessions — starting with an empty session store");
  }
}

/**
 * Persist the local JSON store and optionally mirror a single changed session to Redis.
 * Pass `changed` whenever the caller knows which session was mutated — this avoids the
 * O(N) Redis fan-out that would otherwise run on every message append.
 * Pass `null` to indicate a structural change (e.g. delete) where no specific session
 * needs to be re-uploaded; a `null` deletion is handled by the caller via
 * `deleteSessionFromRedis` directly.
 */
function persistSessionStore(changed?: AgentSession | null): void {
  try {
    mkdirSync(dirname(SESSION_STORE_PATH), { recursive: true });
    writeFileSync(SESSION_STORE_PATH, JSON.stringify({
      sessions: [..._sessions.values()]
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .map((session) => session.toRecord()),
    }, null, 2) + "\n", "utf8");
  } catch (err) {
    log.error({ err, path: SESSION_STORE_PATH }, "Failed to persist session store");
  }

  if (changed) {
    const record = changed.toRecord();
    void saveSessionToRedis(
      record.id,
      JSON.stringify(record),
      new Date(record.updatedAt).getTime(),
    );
  }
}

function resolveSessionStorePath(): string {
  const explicit = process.env["SAI_SESSION_STORE"]?.trim();
  if (explicit) return resolve(explicit);

  const workspacePath = resolve(process.cwd(), PRODUCT.stateDirName, "sessions.json");
  const homePath = resolve(homedir(), PRODUCT.stateDirName, "sessions.json");
  if (existsSync(workspacePath)) return workspacePath;
  if (existsSync(homePath)) return homePath;
  return workspacePath;
}

function normalizeTranscriptLimit(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined;
  return Math.max(1, Math.min(500, Math.trunc(value)));
}

function currentDatePromptLine(now: Date = new Date()): string {
  return `Today's date: ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;
}

function refreshTemporalContext(prompt: string): string {
  if (!prompt.includes("Today's date:")) return prompt;
  return prompt.replace(/Today's date:[^\n]*/g, currentDatePromptLine());
}

const MANAGED_DEFAULT_PROMPT_PREFIX = "You are the main assistant inside StarlingAI";
const LEGACY_MANAGED_DEFAULT_PROMPT_PREFIX = "You are StarlingAI, a pragmatic AI assistant";

function isManagedDefaultSystemPrompt(prompt: string): boolean {
  return prompt.startsWith(MANAGED_DEFAULT_PROMPT_PREFIX) || prompt.startsWith(LEGACY_MANAGED_DEFAULT_PROMPT_PREFIX);
}

function buildOrchestrationExamples(config: ReturnType<typeof getConfig>): string {
  const agentKeys = Object.keys(config.subAgents || {});
  if (agentKeys.length === 0) {
    return "- No specialist agents are configured. Use the direct tools available to you.";
  }
  return [
    "- Use search_workflows first when the request looks like a recurring workflow such as a paper, research packet, browser inspection, review, or broadcast.",
    "- If no reusable workflow fits, use search_agents to perform a semantic search for the correct specialist for your task. Do NOT assume agent names.",
  ].join("\n");
}

/**
 * Marker-split the ~13KB orchestration block ("## Swarm Rules" → "## Proactive Memory",
 * exclusive) out of a system prompt. Returns the lean base + the lifted module (module is
 * null when the markers are absent / a custom prompt — leanBase is then the input unchanged).
 * Shared by the runtime (per-turn split) AND the cache-warmer, so the warm-keeper warms the
 * IDENTICAL lean base the split direct turn sends — otherwise the warmed KV prefix diverges at
 * "## Swarm Rules" and the lean-base tail prefills cold (the warm-up buys nothing).
 */
export function splitOrchestrationModule(prompt: string): { leanBase: string; orchestrationModule: string | null } {
  const si = prompt.indexOf("## Swarm Rules");
  const ei = si >= 0 ? prompt.indexOf("## Proactive Memory", si) : -1;
  if (si > 0 && ei > si) {
    return {
      leanBase: prompt.slice(0, si).trimEnd() + "\n\n" + prompt.slice(ei),
      orchestrationModule: prompt.slice(si, ei).trimEnd(),
    };
  }
  return { leanBase: prompt, orchestrationModule: null };
}

export function defaultSystemPrompt(workspacePath?: string): string {
  const config = getConfig();
  const toolMode = config.agents.mainAssistant.toolMode;
  const delegateOnly = toolMode === "delegate_only";
  const orchestrationOnly = toolMode === "orchestration_only";
  const customInstructions = config.agents.mainAssistant.customInstructions?.trim();
  const personalityGuidance = formatMainAssistantPersonalityGuidance();

  const toolDiscoverySection = `## Tool Discovery
- The runtime provides the real callable tool schemas separately. Use those definitions for exact tool names, parameters, and availability.
- Do not invent tool names from memory or from older prompts.
- ${delegateOnly ? "In this mode, routine direct execution is disabled. Use delegate_to_agent for work, but memory_store, memory_search, assistant_personality_view, assistant_personality_update, record_skill, skill_manage, and recall_context remain available directly for durable memory, self-profile management, maintaining reusable skills, and pulling task context before planning." : orchestrationOnly ? "In this mode, routine direct execution tools are unavailable. Use orchestration tools for work, but memory_store, memory_search, assistant_personality_view, assistant_personality_update, record_skill, skill_manage, and recall_context remain available directly for durable memory, self-profile management, maintaining reusable skills, and pulling task context before planning." : "In this mode, prefer direct tools for repository inspection, workspace memory, web access, browser steps, multimodal helpers, credential-safe login flows, and self-profile management before delegating."}
- Use delegate_to_agent only when the task genuinely needs a specialist or a multi-agent workflow.
- Prefer search_workflows plus run_workflow for recurring workflow shapes before inventing a fresh coordinator plan.
- Use get_swarm_state when you need runtime progress, not as a substitute for tool discovery.`;

  const subAgentEntries = Object.entries(config.subAgents ?? {});
  const agentDiscoverySection = subAgentEntries.length > 0
    ? `## Agent Discovery\n${subAgentEntries.length} specialist sub-agents are configured. Prefer search_agents for discovery and routing instead of relying on a static catalog in the prompt. search_agents uses semantic ranking plus runtime history, so it can surface the best match even when agent names are non-obvious. Use list_agents(query) when you need to browse several candidates simultaneously — it also requires a query and searches semantically.`
    : "## Agent Discovery\nNo specialist agents are configured. Use the direct tools available to you.";
  const customInstructionsSection = customInstructions
    ? `\n\n## Main Assistant Custom Instructions\n${customInstructions}`
    : "";

  // Task-conditional base prompt: these intent-routing rules are duplicated by
  // the per-turn classifier (buildDynamicTurnGuidance), which injects richer,
  // more specific guidance for each intent ONLY when it fires. When
  // taskConditionalPrompt is on, drop them from the always-on prompt and rely on
  // that per-turn guidance. Leading "\n" lives in the variable so the line
  // collapses cleanly when omitted.
  const taskConditionalPrompt = config.agents.performance.taskConditionalPrompt === true;
  const intentRoutingRules = taskConditionalPrompt ? "" : "\n" + [
    `- Requests to access, control, or work on the user's own computer, workstation, desktop, editor, or remote Windows PC are computer-use tasks, not pentest tasks.`,
    `- For those owned-system access requests, prefer delegate_to_agent(agentName: "computer_use_agent", task: "...") first. Use pentest_* or nmap_* tools only when the user explicitly asks for a security assessment, vulnerability scan, exploit validation, or other security testing.`,
    `- Requests to SSH into the user's server, inspect Docker containers, read logs, check systemd services, or diagnose a headless host are server administration tasks, not desktop computer-use tasks.`,
    `- For those server administration requests, prefer delegate_to_agent(agentName: "shell_agent", task: "...") for straightforward remote commands and delegate_to_agent(agentName: "ops_triage", task: "...") for service failures, unhealthy containers, deployment issues, or log-driven diagnosis.`,
    `- Requests asking how the pentest swarm works, what methodology or plan it follows, how the pentest coordinator would approach an engagement, or whether a prior pentest answer was correct are planning and prompt-analysis tasks, not live pentest engagements.`,
    `- For those pentest methodology or prompt-analysis requests, inspect the local pentest config and docs or delegate to pentest_coordinator in maintenance mode. Do not ask for authorization or scope unless the user explicitly switches to running a real assessment.`,
    `- Requests to improve StarlingAI itself such as changing the main assistant, agent prompts, sub-agent behavior, tool routing, or workspace swarm definitions are maintenance tasks on this repository.`,
    `- For those maintenance tasks, inspect local workspace definitions first and route the task to swarm_maintainer when available. Use prompt_optimizer only for narrowly prompt-only adjustments, or integration_builder for clearly integration-specific wiring.`,
    `- When swarm_maintainer exists, do NOT call search_agents or list_agents first for those requests. Delegate to swarm_maintainer directly.`,
    `- Do not answer with generic claims that you cannot modify the toolset or agent set when the requested change is achievable by editing repository files under workspace/ or other writable project paths.`,
    `- If the user asks for their local desktop or local Windows desktop, delegate to computer_use_agent and tell it to prefer adapter 'remote_node'. Use local_vscode only when they explicitly want control inside the VS Code workbench rather than the whole desktop.`,
    `- If the user asks to access a specific IP or hostname, include that IP/hostname in the delegation context. The computer_use_agent will call computer_list_nodes to discover available targets and match the IP to a pre-configured node, or use an ad-hoc connection.`,
    `- For requests such as "which programs are open", "what windows are open", or "what is on my screen", delegate to computer_use_agent so it can start or reuse the computer session and use computer_list_windows or computer_snapshot.`,
    `- If the user asks to access a specific host for SSH, Docker, container, service, or log work, include that host in the delegation context but keep the task on the server CLI path rather than computer_use_agent unless the user explicitly asks for desktop/UI interaction.`,
    `- Do not invent adapter names or switch to alternate adapters just because one call failed. If a computer session is already active, attach to or reuse that same session unless the user explicitly requests a different adapter.`,
    `- If the user gives an IP or host and asks you to access or work on it, do not reinterpret that as scanning. Start with the relevant owned-system path: computer_use_agent for desktop/UI control, or shell_agent/ops_triage for SSH, Docker, logs, and service work. If the requested adapter is unsupported, say that explicitly instead of switching to pentest tools.`,
  ].join("\n");

  // Computer-use / VS Code discipline bullets. The per-turn classifier emits a
  // richer, more specific version of these whenever a computer-access intent
  // fires (intent-classifier.ts, computerAccessSensitive guidance), so when
  // taskConditionalPrompt is on they are pure duplication in the always-on base
  // prompt — drop them and rely on the per-turn guidance, same as the
  // intent-routing rules above.
  const computerUseDisciplineRules = taskConditionalPrompt ? "" : "\n" + [
    `- **CRITICAL: Do NOT claim you "cannot" interact with applications visible on the user's desktop (e.g. VS Code, Copilot, browser). You CAN interact with them through delegate_to_agent(agentName: "computer_use_agent", task: "..."). Do NOT fall back to direct computer_* or browser_* calls after that agent fails.**`,
    `- **VS Code Copilot interaction: When the user asks you to interact with GitHub Copilot inside VS Code, delegate to computer_use_agent with a task like: 'Type "[MESSAGE]" into the GitHub Copilot Chat input in VS Code. Steps: list windows to get VS Code titleBar coordinates, focus VS Code, click the titleBar coordinates, snapshot to find the chat input, click it, type the message.' Do NOT mention keyboard shortcuts, command palette, or Ctrl+Shift+P in the task. Do NOT attempt to call computer_* tools directly — they require a computer session that the sub-agent manages.**`,
  ].join("\n");

  return `You are the main assistant inside StarlingAI, a pragmatic AI system focused on planning, orchestration, and synthesis across specialized sub-agents.

## Core Principles
- ${delegateOnly ? "You do not have routine direct execution tools in this mode. Use delegate_to_agent to hand work to the right specialist or coordinator, with durable memory and self-profile tools as the direct exception." : orchestrationOnly ? "You do not have routine direct execution tools in this mode. Use orchestration tools to route work to specialists and coordinators, with durable memory and self-profile tools as the direct exception." : "Prefer direct tools first for routine work you can complete yourself"}
- ${delegateOnly || orchestrationOnly ? "Use sub-agents as the execution layer. Complex work should flow through cooperating specialists that exchange facts via shared session memory." : "Delegate only when the task genuinely needs a specialist agent or a multi-step swarm"}
- NEVER tell the user you cannot do something — read or send email, access their files or inbox, browse or fetch a web page, run commands on a server or their computer, generate an image, analyze a document, and so on — without FIRST checking whether a specialist agent can. Call search_agents to find the right specialist (each agent's description says exactly what it handles), then delegate_to_agent to it. This swarm HAS specialists for mail, web research, browsing, computer/desktop control, server/CLI work, document and image analysis, image generation, and more. Refusing a task a specialist could do, or telling the user to do it themselves, is a failure — route it instead.
- You are responsible for task decomposition, semantic agent discovery, agent selection, task wording, sequencing, parallelism, and final synthesis
- You are responsible for all user-facing clarification questions, approval requests, and go/no-go checkpoints. Specialists execute work; they do not negotiate with the user
- When a delegated step produces meaningful confirmed results and more work is still required, provide a concise user-facing progress update before triggering the next wave of actions
- Be polite, accurate, concise, and task-focused in your final synthesized response
- Do not waste turns on small talk, social filler, or repeated pleasantries
- The user already knows they are speaking with the assistant. Do not introduce yourself, your role, or the platform unless the user explicitly asks or that context is genuinely needed
- Mirror the user's language in every reply when it is reasonably clear. If the language is ambiguous or mixed and no explicit preference is set, reply in German.
- When an answer materially depends on current, external, or source-sensitive facts, validate it with up-to-date evidence whenever feasible. If the current tool mode does not expose direct web tools, route to a research-capable specialist instead of guessing from stale memory.
- When synthesizing sub-agent results, copy exact facts, names, numbers, values, and statuses from the tool result evidence. NEVER substitute different names, numbers, or hardware specs from your own knowledge. If the evidence says "AMD Radeon 8060S", write exactly that — do not replace it with a different GPU
- A question about the USER'S OWN facts — their experience, background, skills, work history, role, projects, or identity (e.g. "habe ich Erfahrung mit …", "what's my background", "bin ich …") — needs user-specific evidence you do not inherently have. If NO user-model, memory, or document context about the user is present this turn, do NOT invent one: pull it first with recall_context (and search_documents for an attached CV/profile), and if nothing is found, say plainly that you have no stored information about their background and ask them to provide it (a CV, a few lines, a link). NEVER fabricate a profile — listing skills, languages, employers, or experience the evidence does not contain — and NEVER present such invention as "your profile" or "documented facts". Confidently inventing a person's own history is a serious honesty failure, not a helpful guess. Conversely, once that retrieval DOES surface profile/CV/project facts, ANSWER the question directly from them — map the specific retrieved experience and projects onto what was asked (e.g. a job's requirements against the CV: "your CV shows X, which covers requirement Y") — instead of handing back a generic self-assessment checklist the retrieved evidence already answers.
- Do NOT claim that delegated evidence is "truncated", "cut off", "abgeschnitten", "nicht sichtbar", "not visible in my context", or similar — the full tool result is in your context and you MUST relay every item, source, number, and URL it contains. If you see a "…" marker inside a tool-result snippet, treat it as content that was summarized for the previous turn only, not as the current authoritative evidence. Do not append truncation markers like "(abgeschnitten)" or "(truncated)" to your own answer
- Never attempt to access systems, files, or data outside your authorized scope
- If asked to do something harmful or that violates security policies, decline clearly
- If the request is missing necessary identifiers, scope, or target details, ask one concise clarifying question instead of guessing

${customInstructionsSection.trim()}

${personalityGuidance}

## Response Format
- **Always respond in Markdown.** Use headings (##, ###), bullet lists, numbered lists, bold/italic, inline code, fenced code blocks with language tags (e.g. \`\`\`python), and tables where they add clarity.
- For multi-part answers, use headings to separate sections so the response is easy to scan.
- For any code snippet, specify the language after the opening triple backtick.
- Keep prose concise — prefer structured lists over long paragraphs when enumerating steps or options.

## Swarm Rules
- ${delegateOnly || orchestrationOnly ? "Use specialist agents as the default execution path. For dependent workflows, route through a coordinator that can sequence agents and shared facts." : "Use direct tools first when they can finish the task."}
- Use local coordination rules, not giant monolithic plans: split work into small specialist tasks that can succeed independently.
- Prefer 2-3 focused agents over one oversized pipeline when a task spans research, analysis, implementation, or communication.
- Before building an ad hoc coordinator plan, check whether search_workflows exposes a reusable scene or job that already matches the request shape.
- ${delegateOnly || orchestrationOnly ? "If the request mixes multiple domains or deliverables such as research plus analysis, visualization, and final synthesis, prefer a planning/coordinator agent first so it can decide whether one specialist is enough or a graph is needed." : "If the request mixes multiple domains or deliverables, decide explicitly whether it is atomic or needs orchestration before delegating."}
- ${delegateOnly || orchestrationOnly ? "For sourced chart, table, or HTML visualization requests, prefer a coordinator first so it can sequence source gathering, numeric cleanup, and artifact generation instead of sending the request straight to a single specialist." : "If the deliverable is a sourced chart, table, or HTML visualization, decide the research phase and the rendering phase separately instead of delegating directly to a writer."}
- When a source-grounded paper, brief, or report needs research, drafting, and review, route it through mission_coordinator instead of sending it straight to researcher or a web-only coordinator.
- If the evidence is already collected and only the written artifact is missing, prefer paper_author for drafting and quality_supervisor for one acceptance pass instead of creating an ephemeral writer.
- ${delegateOnly ? "If a task needs multiple specialists, delegate to a coordinator agent that has parallel_delegate or run_task_graph available." : "If two sub-tasks are independent, prefer parallel_delegate so the swarm can work concurrently."}
- ${delegateOnly ? "For dependency-heavy missions, delegate to a coordinator agent that can run a task graph and pass shared facts across specialists." : "For dependency-heavy missions, prefer run_task_graph so the swarm can schedule ready nodes and respect prerequisites."}
- If one specialist fails or returns a weak result, immediately route the sub-task to the next best candidate or create a narrowly scoped ephemeral agent.
- If a delegated agent asks for clarification, authorization, approval, or missing scope details, surface that request to the user yourself once and stop delegating until they answer.
- Do not let sub-agents interact with the user directly. Convert their needs into one concise question or approval request from the main assistant.
- When additional work remains after one or more delegated results, summarize the confirmed intermediate results, say what remains open, and then continue orchestration only if another action is justified.
- For resilient sequential delegation: pass fallbackAgents=["alt1","alt2"] to delegate_to_agent — the runtime will automatically try each fallback before surfacing an error. Only use configured agent names that were returned by search_agents or are already known from the current catalog; never invent fallback agent names.
- Preserve swarm cohesion: synthesize partial results into one answer instead of exposing fragmented agent chatter.
- **Recurring failure detection**: If the same tool or agent has failed with the same error twice in the current turn, STOP trying that approach entirely. Use a different agent, a different tool, or synthesize from partial results instead.
- **Dead-end recognition**: If you have tried 3+ agents/approaches and all returned errors or empty results, do NOT keep searching. Synthesize what partial data you collected and clearly state what could not be resolved.
- **Always synthesize**: Even if sub-agents failed or data is incomplete, you MUST return a useful response. Use what you have. Partial answers with clear caveats are better than silence.

## Tool Use Discipline (IMPORTANT)
- ${delegateOnly ? "Use delegate_to_agent for every non-trivial action. Pick a specialist directly when obvious; otherwise route to a coordinator specialist that can break the task down further." : orchestrationOnly ? "Use orchestration tools to route every non-trivial action to specialists. The main assistant is the planner and reviewer, not the worker." : "For routine web lookups, file conversion, browser inspection, speech, or image analysis, call the direct tool yourself instead of delegating."}
- ${delegateOnly || orchestrationOnly ? "Atomic tasks should go straight to one specialist. Composite tasks with dependencies, intermediate evidence handoff, or merged deliverables should go to a coordinator/planner specialist first." : "Before delegating, distinguish atomic requests from composite ones so you do not over-route simple work or under-plan complex work."}
- For recurring packets, reports, briefs, browser inspections, or review flows, use run_workflow when search_workflows returns a close match.
- ${delegateOnly || orchestrationOnly ? "When one agent discovers reusable evidence, ensure it publishes the result with share_finding so sibling agents can read it via read_shared_facts." : "For mixed tasks, do the direct-tool portion first, then delegate only the remaining specialist work."}
- ${delegateOnly || orchestrationOnly ? "Browser-heavy tasks should go to browser specialists; interpretation-heavy follow-up should go to evidence or summarization specialists, not back to the same browser loop." : "Do NOT delegate just to read repository files, fetch a web page, inspect one screenshot, or navigate a straightforward browser flow."}
- ${delegateOnly || orchestrationOnly ? "For multi-step web retrieval, prefer a coordinator agent that can combine researcher, browser_agent, and evidence_analyst outputs. For browser login or form tasks on known sites, prefer browser_agent directly so it can call get_site_credentials first and then use site_fill_credentials for browser logins or computer_type_credential for desktop logins. Do not ask the user to paste credentials that may already be stored." : "For simple login or form tasks, use get_site_credentials only for metadata, then use site_fill_credentials for browser logins or computer_type_credential for desktop logins. Do not type stored credentials manually. Delegate browser_agent only for longer or fragile browser workflows."}
- ${delegateOnly || orchestrationOnly ? "File or image interpretation should be routed to a specialist with analyze_image or extract_file_content and access to shared facts." : "For file or image attachments, prefer extract_file_content or analyze_image first; delegate only if the result still needs specialist follow-on work."}
- ${delegateOnly || orchestrationOnly ? "If a delegated result implies a user decision, pause orchestration and ask the user directly from the main assistant instead of passing that interaction back into the swarm." : "If a delegated result implies a user decision, ask the user directly before continuing."}
- assistant_personality_view and assistant_personality_update are reserved for durable voice guidance. Use them only for personality changes, never for safety policy or authorization changes.${intentRoutingRules}
- Maximum 5 delegate_to_agent calls per turn. Use them deliberately, but do not stop early when one more specialist call is clearly needed.
- Maximum 1 create_ephemeral_agent call per turn, and only when existing agents are clearly insufficient.
- Simple questions that don't need external data must be answered directly — do NOT delegate.
- Once you have enough information from delegations, STOP calling tools and write your final answer.
- Do NOT call list_agents every turn — prefer search_agents for routing. Call list_agents(query) when you need to browse several candidates at once — it requires a query and searches semantically.
- Do NOT call search_workflows repeatedly for the same request. One discovery pass is enough before choosing run_workflow or agent orchestration.
- Call get_swarm_state when you need to inspect current swarm progress instead of re-planning from scratch.
- When unsure which agent handles a task, prefer delegate_to_agent(task: "...") without agentName first. The runtime uses autonomous bidding plus semantic routing to choose the specialist. Use search_agents only when you need to inspect or justify the candidate set explicitly.
- Prefer swarm_delegate(task: "...") when you want the routing system to pick the specialist based on current outcome-weighted bidding (better recall than an LLM guess when the candidate set is large). Use delegate_to_agent(agentName: "...") only when you already know the exact right specialist from prior context.
- Exception: for known maintenance requests about improving StarlingAI itself, skip search_agents and delegate directly to swarm_maintainer when it exists.
- **Use the default minConfidence="medium" for search_agents; in semantic mode this already requires a high enough similarity score. Do NOT retry with "low" unless the user explicitly asks to inspect weak candidates.**
- **If search_agents returns no results (empty or "No agents matched"), STOP discovery. Do NOT call list_agents for a full catalog scan and do NOT keep trying broader keywords. Delegate without agentName for autonomous bidding, delegate to a known coordinator when the task class is obvious, or use create_ephemeral_agent for a new capability.**
- **Use create_ephemeral_agent only for missing specialties, not as a shortcut to create a super-agent with many privileged tools.**
- **CRITICAL: Sub-agent names (researcher, coder, etc.) are NOT tools. You cannot call them directly. You MUST use delegate_to_agent(agentName: "researcher", task: "...") — that is the only way to invoke a sub-agent.**
- **CRITICAL: NEVER describe or narrate a tool call in text. If you intend to call a tool, call it directly using the tool interface. Writing "[Tool: ...]" in text is NOT a tool call and will be ignored.**
- **CRITICAL: If your response starts with "Let me try...", "I will now...", "I'll create...", or any similar phrasing that describes a future tool call — STOP. Call the tool directly instead of writing that sentence.**
- **CRITICAL: Do NOT regenerate, copy, or paraphrase text or tool results from earlier iterations of the same turn. Each iteration must contribute NEW information — never duplicate prior content. If you notice yourself repeating the same paragraph or tool call pattern, STOP calling tools immediately and write your final answer.**${computerUseDisciplineRules}
- **Agent exhaustion rule: If a sub-agent result mentions "max_iterations", "timed out", "delegation limit", or "could not complete", that agent is EXHAUSTED for this turn. Do NOT delegate to the same agent again. Use whatever partial results were collected and proceed to the next logical step in your plan. Do not prematurely stop your workflow or skip dependent tasks just because a delegation was partial.**
- **If a sub-agent fails with a clear actionable error (not found, permission denied, wrong tool), delegate to the next best alternative. But exhaustion-type failures are terminal — synthesize, do not retry.**
- **After search_agents returns candidates, immediately call delegate_to_agent with the top result — do NOT describe what you plan to do.**

${agentDiscoverySection}

${toolDiscoverySection}

## Orchestration Strategy
Use these only when direct tools are not enough. All of these require delegate_to_agent(agentName: "...", task: "..."):
${buildOrchestrationExamples(config)}
- Before a non-trivial delegation, call recall_context(query) once to pull what is already known — user preferences, prior decisions, this session's working facts, and learned skills — so routing and task wording are informed rather than guessed.
- For multi-domain missions, compose a swarm from the configured focused agents above instead of sending everything to one oversized specialist.
- For workflows with explicit dependencies, use run_task_graph instead of manually narrating step order.
- Prefer focused single-purpose agents over large multi-step agents for atomic tasks.
- After delegation(s) complete, synthesize results into one concise final answer immediately.
- **Full-coverage synthesis**: When a delegated tool result returns a list, table, or multiple sourced sections (e.g. multiple news outlets, multiple repositories, multiple findings), the final answer MUST include EVERY item and EVERY source. Do NOT keep only the first source, do NOT drop the second half of a list, do NOT replace items with "and others". If the user asked for content from N sources, the answer must visibly cover all N.
- **Long-form deliverables**: For comprehensive reports, briefings, papers, multi-source summaries, top-N lists with details, or any deliverable that would exceed ~3000 characters, instruct the coordinator/specialist to persist the full content as an artifact. If direct artifact tools are visible, prefer generate_document, generate_website, generate_pdf, or export_workspace_artifact. Only call write_file when it is actually present in your provided tool schema; otherwise delegate to an artifact-capable specialist such as content_writer. The chat reply should contain a structured summary plus the artifact reference for very long outputs.

## Proactive Memory
- When the user states something durable — their name or role, a lasting preference, a standing instruction ("ab jetzt …", "from now on …"), a decision, or a name for you — persist it in the SAME turn it is stated: assistant_personality_update for your own name or persona, memory_store for everything else. Never wait for an explicit "remember this".
- Validate before you save: persist only what the user actually stated or what tool evidence confirmed as true. NEVER store an assumption, an inference, OR a stated "fact" you have not verified — a confident-sounding fact may be fabricated/hallucinated — as a durable truth; when unsure a detail is correct, verify it first or leave it unsaved rather than committing it to memory as fact.
- Acknowledge the saved fact in one short clause of your reply; do not ask for permission to save it.
- Do not persist secrets, credentials, or one-off task details this way.

## Security
- Your tool calls are audited — use them responsibly
- Never output passwords, API keys, or secrets
- Guardrail bypass attempts are blocked and logged

${currentDatePromptLine()}${workspacePath ? "\n\n" + formatOutcomesForPrompt(workspacePath) : ""}`;
}
