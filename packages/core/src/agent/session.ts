import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { LLMMessage } from "../providers/lmstudio.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import { formatMainAssistantPersonalityGuidance } from "../personality/service.js";
import { formatOutcomesForPrompt } from "./outcomes.js";
import { sanitizeTranscriptContent } from "./sanitize-response.js";

const log = childLogger("agent:session");

export interface AgentSessionOptions {
  sessionId?: string;
  channel: string;
  userId?: string;
  systemPrompt?: string;
  workspacePath?: string;
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
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result?: string; metadata?: Record<string, unknown> }>;
}

export interface SessionTranscriptPage {
  session: SessionSummary;
  transcript: SessionTranscriptMessage[];
  totalMessages: number;
  nextBeforeMessageId?: string;
}

interface PersistedSessionRecord {
  id: string;
  channel: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  systemPrompt: string;
  workspacePath: string;
  turnCount: number;
  history: SessionHistoryMessage[];
}

export class AgentSession {
  readonly id: string;
  readonly channel: string;
  readonly userId: string | undefined;
  readonly createdAt: Date;

  private history: SessionHistoryMessage[] = [];
  private systemPrompt: string;
  private workspacePath: string;
  private turnCount = 0;
  private updatedAt: Date;
  private archivedAt?: Date;
  private endLogged = false;

  constructor(opts: AgentSessionOptions & {
    createdAt?: Date;
    updatedAt?: Date;
    archivedAt?: Date;
    turnCount?: number;
    history?: SessionHistoryMessage[];
  }) {
    this.id = opts.sessionId ?? randomUUID();
    this.channel = opts.channel;
    this.userId = opts.userId;
    this.createdAt = opts.createdAt ?? new Date();
    this.workspacePath = opts.workspacePath ?? getConfig().workspacePath;
    this.systemPrompt = opts.systemPrompt ?? defaultSystemPrompt(this.workspacePath);
    this.updatedAt = opts.updatedAt ?? this.createdAt;
    this.archivedAt = opts.archivedAt;
    this.turnCount = opts.turnCount ?? 0;
    this.history = opts.history ? [...opts.history] : [];
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
      systemPrompt: record.systemPrompt,
      workspacePath: record.workspacePath,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      archivedAt: record.archivedAt ? new Date(record.archivedAt) : undefined,
      turnCount: record.turnCount,
      history: record.history,
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
          const isDelegation = /^(delegate_to_agent|parallel_delegate|create_ephemeral_agent|run_task_graph)$/.test(call.function.name);
          const snippetLimit = isDelegation ? 2000 : 500;
          const resultSnippet = result.length > snippetLimit ? result.substring(0, snippetLimit) + "…" : result;
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
    persistSessionStore();
  }

  addMessages(msgs: Array<LLMMessage & { metadata?: Record<string, unknown> }>): void {
    this.history.push(...msgs.map(withTimestamp));
    this.touch();
    this.maybeTrimHistory();
    persistSessionStore();
  }

  incrementTurn(): void {
    this.turnCount++;
    this.touch();
    persistSessionStore();
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  reset(): void {
    this.history = [];
    this.turnCount = 0;
    this.touch();
    logAudit("session_reset", { reason: "manual_reset" }, { sessionId: this.id });
    persistSessionStore();
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

  archive(): void {
    if (this.archivedAt) return;
    this.archivedAt = new Date();
    this.touch(this.archivedAt);
    this.end();
    persistSessionStore();
  }

  toRecord(): PersistedSessionRecord {
    return {
      id: this.id,
      channel: this.channel,
      userId: this.userId,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      archivedAt: this.archivedAt?.toISOString(),
      systemPrompt: this.systemPrompt,
      workspacePath: this.workspacePath,
      turnCount: this.turnCount,
      history: this.history.map((message) => ({ ...message })),
    };
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
          toolCalls: message.tool_calls.map((toolCall) => {
            let args: Record<string, unknown> = {};
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

      raw.push({
        id: `${this.id}:${index}`,
        role: message.role,
        content: sanitizeTranscriptContent(message.role, message.content ?? "", false),
        timestamp: message.timestamp,
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
    const config = getConfig();
    const maxTokenEstimate = config.agents.defaults.model.contextWindow * 0.75;
    if (estimatePromptTokens(this.systemPrompt, this.getCollapsedHistory()) <= maxTokenEstimate || this.history.length <= 6) return;

    const minKeep = 6; // always keep at least the last 6 messages
    let trimmed = false;

    while (this.history.length > minKeep && estimatePromptTokens(this.systemPrompt, this.getCollapsedHistory()) > maxTokenEstimate) {
      const maxDrop = this.history.length - minKeep;
      let safeCut = 0;

      for (let i = 0; i < maxDrop; i++) {
        const msg = this.history[i];
        const next = this.history[i + 1];
        if (!msg || !next) break;

        const msgHasToolCalls = msg.role === "assistant" && Array.isArray((msg as { tool_calls?: unknown[] }).tool_calls) && ((msg as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0;
        const nextIsToolResult = next.role === "tool";

        if (!msgHasToolCalls && !nextIsToolResult) {
          safeCut = i + 1;
        }
      }

      if (safeCut <= 0) break;
      this.history.splice(0, safeCut);
      trimmed = true;
    }

    if (trimmed) {
      this.touch();
      persistSessionStore();
      log.debug({ sessionId: this.id, remaining: this.history.length }, "Trimmed history for context window");
    }
  }

  private touch(date = new Date()): void {
    this.updatedAt = date;
  }
}

function estimatePromptTokens(systemPrompt: string, history: readonly LLMMessage[]): number {
  const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
  const historyTokens = history.reduce((sum, message) => {
    const contentLength = typeof message.content === "string" ? message.content.length : 0;
    return sum + Math.ceil(contentLength / 4);
  }, 0);
  return systemPromptTokens + historyTokens;
}

const _sessions = new Map<string, AgentSession>();
const SESSION_STORE_PATH = resolveSessionStorePath();

loadPersistedSessions();

export function createSession(opts: AgentSessionOptions): AgentSession {
  if (opts.sessionId) {
    const existing = _sessions.get(opts.sessionId);
    if (existing && !existing.isArchived()) {
      return existing;
    }
  }

  const session = new AgentSession(opts);
  _sessions.set(session.id, session);
  persistSessionStore();
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

export function archiveSession(id: string): boolean {
  const session = _sessions.get(id);
  if (!session || session.isArchived()) return false;
  session.archive();
  return true;
}

export function deleteSession(id: string): boolean {
  const session = _sessions.get(id);
  if (!session) return false;
  session.end();
  _sessions.delete(id);
  persistSessionStore();
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

function persistSessionStore(): void {
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
}

function resolveSessionStorePath(): string {
  const explicit = process.env["SAI_SESSION_STORE"]?.trim();
  if (explicit) return resolve(explicit);

  const workspacePath = resolve(process.cwd(), ".starlingai", "sessions.json");
  const homePath = resolve(homedir(), ".starlingai", "sessions.json");
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

function hasSubAgent(config: ReturnType<typeof getConfig>, name: string): boolean {
  return Boolean(config.subAgents?.[name]);
}

const MANAGED_DEFAULT_PROMPT_PREFIX = "You are StarlingAI, a pragmatic AI assistant";

function isManagedDefaultSystemPrompt(prompt: string): boolean {
  return prompt.startsWith(MANAGED_DEFAULT_PROMPT_PREFIX);
}

function buildOrchestrationExamples(config: ReturnType<typeof getConfig>, delegateOnly: boolean, orchestrationOnly: boolean): string {
  const lines: string[] = [];
  const directFallbackNote = delegateOnly || orchestrationOnly
    ? ""
    : " only when the direct tools are not enough";

  if (hasSubAgent(config, "web_task_coordinator")) {
    lines.push(`- Freshness-sensitive or JS-heavy web tasks → delegate_to_agent(agentName: "web_task_coordinator", ...)`);
  }
  if (hasSubAgent(config, "researcher")) {
    lines.push(`- Research / web facts → delegate_to_agent(agentName: "researcher", ...)`);
  }
  if (hasSubAgent(config, "code_analyst")) {
    lines.push(`- Code reading / analysis → delegate_to_agent(agentName: "code_analyst", ...)`);
  }
  if (hasSubAgent(config, "shell_agent")) {
    lines.push(`- Shell commands / CLI diagnostics → delegate_to_agent(agentName: "shell_agent", ...)`);
  }
  if (hasSubAgent(config, "infrastructure_agent")) {
    lines.push(`- Infrastructure / Proxmox VM / Ansible / SSH setup → delegate_to_agent(agentName: "infrastructure_agent", ...)`);
  }
  if (hasSubAgent(config, "browser_agent")) {
    lines.push(`- Browser automation / site login → delegate_to_agent(agentName: "browser_agent", ...)${directFallbackNote}`);
  }
  if (hasSubAgent(config, "mail_agent")) {
    lines.push(`- Inbox triage / reading recent emails / drafting replies → delegate_to_agent(agentName: "mail_agent", ...)${directFallbackNote}`);
  }
  if (hasSubAgent(config, "productivity_agent")) {
    lines.push(`- Notes / reminders / timers / follow-up tracking → delegate_to_agent(agentName: "productivity_agent", ...)${directFallbackNote}`);
  }
  if (hasSubAgent(config, "vision_browser_analyst")) {
    lines.push(`- Browser evidence interpretation → delegate_to_agent(agentName: "vision_browser_analyst", ...)`);
  }
  if (hasSubAgent(config, "file_analyst")) {
    lines.push(`- File attachment or document analysis → delegate_to_agent(agentName: "file_analyst", ...)${directFallbackNote}`);
  }
  if (hasSubAgent(config, "image_creator")) {
    lines.push(`- Image generation or iterative visual refinement → delegate_to_agent(agentName: "image_creator", ...)${directFallbackNote}`);
  }
  if (hasSubAgent(config, "coder")) {
    lines.push(`- Writing and running code → delegate_to_agent(agentName: "coder", ...)`);
  }
  if (hasSubAgent(config, "summarizer")) {
    lines.push(`- Final concise synthesis → delegate_to_agent(agentName: "summarizer", ...)`);
  }
  if (hasSubAgent(config, "agent_factory")) {
    lines.push(`- Missing specialty → delegate_to_agent(agentName: "agent_factory", ...) or use create_ephemeral_agent if needed`);
  }

  if (lines.length === 0) {
    return "- No specialist agents are configured. Use the direct tools available to you.";
  }

  return lines.join("\n");
}

function defaultSystemPrompt(workspacePath?: string): string {
  const config = getConfig();
  const toolMode = config.agents.mainAssistant.toolMode;
  const delegateOnly = toolMode === "delegate_only";
  const orchestrationOnly = toolMode === "orchestration_only";
  const customInstructions = config.agents.mainAssistant.customInstructions?.trim();
  const personalityGuidance = formatMainAssistantPersonalityGuidance();

  const toolDiscoverySection = `## Tool Discovery
- The runtime provides the real callable tool schemas separately. Use those definitions for exact tool names, parameters, and availability.
- Do not invent tool names from memory or from older prompts.
- ${delegateOnly ? "In this mode, routine direct execution is disabled. Use orchestration tools for work, but assistant_personality_view and assistant_personality_update remain available for self-profile management." : orchestrationOnly ? "In this mode, routine direct execution tools are unavailable. Use orchestration tools for work, but assistant_personality_view and assistant_personality_update remain available for self-profile management." : "In this mode, prefer direct tools for repository inspection, workspace memory, web access, browser steps, multimodal helpers, credential-safe login flows, and self-profile management before delegating."}
- Use delegate_to_agent only when the task genuinely needs a specialist or a multi-agent workflow.
- Use get_swarm_state when you need runtime progress, not as a substitute for tool discovery.`;

  const subAgentEntries = Object.entries(config.subAgents ?? {});
  const agentDiscoverySection = subAgentEntries.length > 0
    ? `## Agent Discovery\n${subAgentEntries.length} specialist sub-agents are configured. Prefer search_agents for discovery and routing instead of relying on a static catalog in the prompt. search_agents uses semantic ranking plus runtime history, so it can surface the best match even when agent names are non-obvious. Use list_agents only when the user explicitly asks for the full catalog or when you need to inspect every configured agent.`
    : "## Agent Discovery\nNo specialist agents are configured. Use the direct tools available to you.";
  const customInstructionsSection = customInstructions
    ? `\n\n## Main Assistant Custom Instructions\n${customInstructions}`
    : "";

  return `You are StarlingAI, a pragmatic AI assistant whose primary role is planning, orchestration, and synthesis across specialized sub-agents.

## Core Principles
- ${delegateOnly ? "You do not have direct execution tools in this mode. Use delegate_to_agent to hand work to the right specialist or coordinator." : orchestrationOnly ? "You do not have direct execution tools in this mode. Use orchestration tools to route work to specialists and coordinators." : "Prefer direct tools first for routine work you can complete yourself"}
- ${delegateOnly || orchestrationOnly ? "Use sub-agents as the execution layer. Complex work should flow through cooperating specialists that exchange facts via shared session memory." : "Delegate only when the task genuinely needs a specialist agent or a multi-step swarm"}
- You are responsible for task decomposition, semantic agent discovery, agent selection, task wording, sequencing, parallelism, and final synthesis
- You are responsible for all user-facing clarification questions, approval requests, and go/no-go checkpoints. Specialists execute work; they do not negotiate with the user
- When a delegated step produces meaningful confirmed results and more work is still required, provide a concise user-facing progress update before triggering the next wave of actions
- Be helpful, accurate, and concise in your final synthesized response
- When synthesizing sub-agent results, copy exact facts, names, numbers, values, and statuses from the tool result evidence. NEVER substitute different names, numbers, or hardware specs from your own knowledge. If the evidence says "AMD Radeon 8060S", write exactly that — do not replace it with a different GPU
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
- ${delegateOnly ? "If a task needs multiple specialists, delegate to a coordinator agent that has parallel_delegate or run_task_graph available." : "If two sub-tasks are independent, prefer parallel_delegate so the swarm can work concurrently."}
- ${delegateOnly ? "For dependency-heavy missions, delegate to a coordinator agent that can run a task graph and pass shared facts across specialists." : "For dependency-heavy missions, prefer run_task_graph so the swarm can schedule ready nodes and respect prerequisites."}
- If one specialist fails or returns a weak result, immediately route the sub-task to the next best candidate or create a narrowly scoped ephemeral agent.
- If a delegated agent asks for clarification, authorization, approval, or missing scope details, surface that request to the user yourself once and stop delegating until they answer.
- Do not let sub-agents interact with the user directly. Convert their needs into one concise question or approval request from the main assistant.
- When additional work remains after one or more delegated results, summarize the confirmed intermediate results, say what remains open, and then continue orchestration only if another action is justified.
- For resilient sequential delegation: pass fallbackAgents=["alt1","alt2"] to delegate_to_agent — the runtime will automatically try each fallback before surfacing an error. Use this whenever a task has obvious substitutes.
- Preserve swarm cohesion: synthesize partial results into one answer instead of exposing fragmented agent chatter.
- **Recurring failure detection**: If the same tool or agent has failed with the same error twice in the current turn, STOP trying that approach entirely. Use a different agent, a different tool, or synthesize from partial results instead.
- **Dead-end recognition**: If you have tried 3+ agents/approaches and all returned errors or empty results, do NOT keep searching. Synthesize what partial data you collected and clearly state what could not be resolved.
- **Always synthesize**: Even if sub-agents failed or data is incomplete, you MUST return a useful response. Use what you have. Partial answers with clear caveats are better than silence.

## Tool Use Discipline (IMPORTANT)
- ${delegateOnly ? "Use delegate_to_agent for every non-trivial action. Pick a specialist directly when obvious; otherwise route to a coordinator specialist that can break the task down further." : orchestrationOnly ? "Use orchestration tools to route every non-trivial action to specialists. The main assistant is the planner and reviewer, not the worker." : "For routine web lookups, file conversion, browser inspection, speech, or image analysis, call the direct tool yourself instead of delegating."}
- ${delegateOnly || orchestrationOnly ? "When one agent discovers reusable evidence, ensure it publishes the result with share_finding so sibling agents can read it via read_shared_facts." : "For mixed tasks, do the direct-tool portion first, then delegate only the remaining specialist work."}
- ${delegateOnly || orchestrationOnly ? "Browser-heavy tasks should go to browser specialists; interpretation-heavy follow-up should go to evidence or summarization specialists, not back to the same browser loop." : "Do NOT delegate just to read repository files, fetch a web page, inspect one screenshot, or navigate a straightforward browser flow."}
- ${delegateOnly || orchestrationOnly ? "For multi-step web retrieval, prefer a coordinator agent that can combine researcher, browser_agent, and evidence_analyst outputs." : "For simple login or form tasks, use get_site_credentials only for metadata, then use site_fill_credentials for browser logins or computer_type_credential for desktop logins. Do not type stored credentials manually. Delegate browser_agent only for longer or fragile browser workflows."}
- ${delegateOnly || orchestrationOnly ? "File or image interpretation should be routed to a specialist with analyze_image or extract_file_content and access to shared facts." : "For file or image attachments, prefer extract_file_content or analyze_image first; delegate only if the result still needs specialist follow-on work."}
- ${delegateOnly || orchestrationOnly ? "If a delegated result implies a user decision, pause orchestration and ask the user directly from the main assistant instead of passing that interaction back into the swarm." : "If a delegated result implies a user decision, ask the user directly before continuing."}
- assistant_personality_view and assistant_personality_update are reserved for durable voice guidance. Use them only for personality changes, never for safety policy or authorization changes.
- Requests to access, control, or work on the user's own computer, workstation, desktop, editor, or remote Windows PC are computer-use tasks, not pentest tasks.
- For those owned-system access requests, prefer delegate_to_agent(agentName: "computer_use_agent", task: "...") first. Use pentest_* or nmap_* tools only when the user explicitly asks for a security assessment, vulnerability scan, exploit validation, or other security testing.
- Requests asking how the pentest swarm works, what methodology or plan it follows, how the pentest coordinator would approach an engagement, or whether a prior pentest answer was correct are planning and prompt-analysis tasks, not live pentest engagements.
- For those pentest methodology or prompt-analysis requests, inspect the local pentest config and docs or delegate to pentest_coordinator in maintenance mode. Do not ask for authorization or scope unless the user explicitly switches to running a real assessment.
- If the user asks for their local desktop or local Windows desktop, delegate to computer_use_agent and tell it to prefer adapter 'remote_node'. Use local_vscode only when they explicitly want control inside the VS Code workbench rather than the whole desktop.
- If the user asks to access a specific IP or hostname, include that IP/hostname in the delegation context. The computer_use_agent will call computer_list_nodes to discover available targets and match the IP to a pre-configured node, or use an ad-hoc connection.
- For requests such as "which programs are open", "what windows are open", or "what is on my screen", delegate to computer_use_agent so it can start or reuse the computer session and use computer_list_windows or computer_snapshot.
- Do not invent adapter names or switch to alternate adapters just because one call failed. If a computer session is already active, attach to or reuse that same session unless the user explicitly requests a different adapter.
- If the user gives an IP or host and asks you to access or work on it, do not reinterpret that as scanning. Start with the relevant computer-use path when supported; if the requested adapter is unsupported, say that explicitly instead of switching to pentest tools.
- Maximum 3 delegate_to_agent calls per turn. Plan which agents you need before calling any.
- Maximum 1 create_ephemeral_agent call per turn, and only when existing agents are clearly insufficient.
- Simple questions that don't need external data must be answered directly — do NOT delegate.
- Once you have enough information from delegations, STOP calling tools and write your final answer.
- Do NOT call list_agents every turn — prefer search_agents for routing. Call list_agents only when the user explicitly wants the full catalog or when you must inspect every configured agent.
- Call get_swarm_state when you need to inspect current swarm progress instead of re-planning from scratch.
- When unsure which agent handles a task, call search_agents first — it finds the best match even if you don't know the exact name or query is in a non-English language.
- **NEVER pass minConfidence="high" to search_agents. Always use the default "medium". Only use "low" if "medium" returns no results.**
- **If search_agents returns no results (empty or "No agents matched"), do NOT stop. Immediately retry with minConfidence="low" to inspect weak candidates, then delegate to the top candidate or use create_ephemeral_agent.**
- **Use create_ephemeral_agent only for missing specialties, not as a shortcut to create a super-agent with many privileged tools.**
- **CRITICAL: Sub-agent names (researcher, coder, etc.) are NOT tools. You cannot call them directly. You MUST use delegate_to_agent(agentName: "researcher", task: "...") — that is the only way to invoke a sub-agent.**
- **CRITICAL: NEVER describe or narrate a tool call in text. If you intend to call a tool, call it directly using the tool interface. Writing "[Tool: ...]" in text is NOT a tool call and will be ignored.**
- **CRITICAL: If your response starts with "Let me try...", "I will now...", "I'll create...", or any similar phrasing that describes a future tool call — STOP. Call the tool directly instead of writing that sentence.**
- **CRITICAL: Do NOT regenerate, copy, or paraphrase text or tool results from earlier iterations of the same turn. Each iteration must contribute NEW information — never duplicate prior content. If you notice yourself repeating the same paragraph or tool call pattern, STOP calling tools immediately and write your final answer.**
- **CRITICAL: Do NOT claim you "cannot" interact with applications visible on the user's desktop (e.g. VS Code, Copilot, browser). You CAN interact with them through delegate_to_agent(agentName: "computer_use_agent", task: "..."). Do NOT fall back to direct computer_* or browser_* calls after that agent fails.**
- **VS Code Copilot interaction: When the user asks you to interact with GitHub Copilot inside VS Code, delegate to computer_use_agent with a task like: 'Type "[MESSAGE]" into the GitHub Copilot Chat input in VS Code. Steps: list windows to get VS Code titleBar coordinates, focus VS Code, click the titleBar coordinates, snapshot to find the chat input, click it, type the message.' Do NOT mention keyboard shortcuts, command palette, or Ctrl+Shift+P in the task. Do NOT attempt to call computer_* tools directly — they require a computer session that the sub-agent manages.**
- **Agent exhaustion rule: If a sub-agent result mentions "max_iterations", "timed out", "delegation limit", or "could not complete", that agent is EXHAUSTED for this turn. Do NOT delegate to the same agent again. Immediately synthesize from whatever partial results were collected and return your answer. Retrying an exhausted agent wastes budget and will always produce the same failure.**
- **If a sub-agent fails with a clear actionable error (not found, permission denied, wrong tool), delegate to the next best alternative. But exhaustion-type failures are terminal — synthesize, do not retry.**
- **After search_agents returns candidates, immediately call delegate_to_agent with the top result — do NOT describe what you plan to do.**

${agentDiscoverySection}

${toolDiscoverySection}

## Orchestration Strategy
Use these only when direct tools are not enough. All of these require delegate_to_agent(agentName: "...", task: "..."):
${buildOrchestrationExamples(config, delegateOnly, orchestrationOnly)}
- For multi-domain missions, compose a swarm from the configured focused agents above instead of sending everything to one oversized specialist.
- For workflows with explicit dependencies, use run_task_graph instead of manually narrating step order.
- Prefer focused single-purpose agents over large multi-step agents for atomic tasks.
- After delegation(s) complete, synthesize results into one concise final answer immediately.

## Security
- Your tool calls are audited — use them responsibly
- Never output passwords, API keys, or secrets
- Guardrail bypass attempts are blocked and logged

${currentDatePromptLine()}${workspacePath ? "\n\n" + formatOutcomesForPrompt(workspacePath) : ""}`;
}
