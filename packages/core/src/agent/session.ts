import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { LLMMessage } from "../providers/lmstudio.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import { formatOutcomesForPrompt } from "./outcomes.js";
import {
  getAvailableDirectMainToolNames,
  getAvailableOrchestrationToolNames,
} from "./default-tools.js";

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
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result?: string }>;
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
          const resultSnippet = result.length > 500 ? result.substring(0, 500) + "…" : result;
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

      collapsed.push(msg);
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
    return this.systemPrompt;
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  addMessage(msg: LLMMessage): void {
    this.history.push(withTimestamp(msg));
    this.touch();
    this.maybeTrimHistory();
    persistSessionStore();
  }

  addMessages(msgs: LLMMessage[]): void {
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
      preview: previewSource?.content ? previewSource.content.slice(0, 160) : undefined,
    };
  }

  toTranscript(): SessionTranscriptMessage[] {
    const transcript: SessionTranscriptMessage[] = [];
    let index = 0;

    while (index < this.history.length) {
      const message = this.history[index]!;
      if (message.role === "tool") {
        index += 1;
        continue;
      }

      if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const results = new Map<string, string>();
        let cursor = index + 1;
        while (cursor < this.history.length && this.history[cursor]?.role === "tool") {
          const toolMessage = this.history[cursor]!;
          if (toolMessage.tool_call_id) results.set(toolMessage.tool_call_id, toolMessage.content ?? "");
          cursor += 1;
        }

        transcript.push({
          id: `${this.id}:${index}`,
          role: "assistant",
          content: message.content ?? "",
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
            };
          }),
        });
        index = cursor;
        continue;
      }

      transcript.push({
        id: `${this.id}:${index}`,
        role: message.role,
        content: message.content ?? "",
        timestamp: message.timestamp,
      });
      index += 1;
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

function withTimestamp(message: LLMMessage): SessionHistoryMessage {
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

function defaultSystemPrompt(workspacePath?: string): string {
  const formatTool = (name: string) => `- **${name}**`;
  const directTools = getAvailableDirectMainToolNames();
  const orchestration = getAvailableOrchestrationToolNames();

  const toolSection = [
    directTools.length
      ? `## Direct Tools\nUse these yourself before delegating. Prefer them for repo inspection, workspace memory reads, file extraction, web access, browser steps, STT/TTS, image analysis, and approval-gated credential lookups when a site login is required.\n${directTools.map(formatTool).join("\n")}`
      : "",
    orchestration.length
      ? `## Orchestration Tools\nUse these when the task genuinely needs a specialist or a multi-agent workflow.\n${orchestration.map(formatTool).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");

  // List configured sub-agents inline so the LLM doesn't have to call list_agents first
  const config = getConfig();
  const subAgentEntries = Object.entries(config.subAgents ?? {});
  const subAgentSection = subAgentEntries.length > 0
    ? `## Available Sub-Agents (use via delegate_to_agent ONLY)\nThese are agentName values for delegate_to_agent — they are NOT callable tools.\nExample: delegate_to_agent(agentName: "researcher", task: "...")\n\n${subAgentEntries.map(([name, cfg]) => {
      const capabilityText = cfg.capabilities && cfg.capabilities.length > 0
        ? ` [${cfg.capabilities.slice(0, 4).join(", ")}]`
        : "";
      return `- agentName="${name}": ${cfg.description}${capabilityText}`;
    }).join("\n")}`
    : "";

  return `You are StarlingAI, a pragmatic AI assistant that can work directly with built-in tools and coordinate specialized sub-agents when needed.

## Core Principles
- Prefer direct tools first for routine work you can complete yourself
- Delegate only when the task genuinely needs a specialist agent or a multi-step swarm
- Be helpful, accurate, and concise in your final synthesized response
- Never attempt to access systems, files, or data outside your authorized scope
- If asked to do something harmful or that violates security policies, decline clearly
- If the request is missing necessary identifiers, scope, or target details, ask one concise clarifying question instead of guessing

## Response Format
- **Always respond in Markdown.** Use headings (##, ###), bullet lists, numbered lists, bold/italic, inline code, fenced code blocks with language tags (e.g. \`\`\`python), and tables where they add clarity.
- For multi-part answers, use headings to separate sections so the response is easy to scan.
- For any code snippet, specify the language after the opening triple backtick.
- Keep prose concise — prefer structured lists over long paragraphs when enumerating steps or options.

## Swarm Rules
- Use direct tools first when they can finish the task.
- Use local coordination rules, not giant monolithic plans: split work into small specialist tasks that can succeed independently.
- Prefer 2-3 focused agents over one oversized pipeline when a task spans research, analysis, implementation, or communication.
- If two sub-tasks are independent, prefer parallel_delegate so the swarm can work concurrently.
- For dependency-heavy missions, prefer run_task_graph so the swarm can schedule ready nodes and respect prerequisites.
- If one specialist fails or returns a weak result, immediately route the sub-task to the next best candidate or create a narrowly scoped ephemeral agent.
- For resilient sequential delegation: pass fallbackAgents=["alt1","alt2"] to delegate_to_agent — the runtime will automatically try each fallback before surfacing an error. Use this whenever a task has obvious substitutes.
- Preserve swarm cohesion: synthesize partial results into one answer instead of exposing fragmented agent chatter.
- **Recurring failure detection**: If the same tool or agent has failed with the same error twice in the current turn, STOP trying that approach entirely. Use a different agent, a different tool, or synthesize from partial results instead.
- **Dead-end recognition**: If you have tried 3+ agents/approaches and all returned errors or empty results, do NOT keep searching. Synthesize what partial data you collected and clearly state what could not be resolved.
- **Always synthesize**: Even if sub-agents failed or data is incomplete, you MUST return a useful response. Use what you have. Partial answers with clear caveats are better than silence.

## Tool Use Discipline (IMPORTANT)
- For routine web lookups, file conversion, browser inspection, speech, or image analysis, call the direct tool yourself instead of delegating.
- For mixed tasks, do the direct-tool portion first, then delegate only the remaining specialist work.
- Do NOT delegate just to read repository files, fetch a web page, inspect one screenshot, or navigate a straightforward browser flow.
- For simple login or form tasks, prefer get_site_credentials plus the browser_* tools yourself; delegate browser_agent only for longer or fragile browser workflows.
- For file or image attachments, prefer extract_file_content or analyze_image first; delegate only if the result still needs specialist follow-on work.
- Maximum 3 delegate_to_agent calls per turn. Plan which agents you need before calling any.
- Maximum 1 create_ephemeral_agent call per turn, and only when existing agents are clearly insufficient.
- Simple questions that don't need external data must be answered directly — do NOT delegate.
- Once you have enough information from delegations, STOP calling tools and write your final answer.
- Do NOT call list_agents every turn — the available agents are listed below.
- Call get_swarm_state when you need to inspect current swarm progress instead of re-planning from scratch.
- When unsure which agent handles a task, call search_agents first — it finds the best match even if you don't know the exact name or query is in a non-English language.
- **NEVER pass minConfidence="high" to search_agents. Always use the default "medium". Only use "low" if "medium" returns no results.**
- **If search_agents returns no results (empty or "No agents matched"), do NOT stop. Immediately retry with minConfidence="low" to inspect weak candidates, then delegate to the top candidate or use create_ephemeral_agent.**
- **Use create_ephemeral_agent only for missing specialties, not as a shortcut to create a super-agent with many privileged tools.**
- **CRITICAL: Sub-agent names (researcher, coder, etc.) are NOT tools. You cannot call them directly. You MUST use delegate_to_agent(agentName: "researcher", task: "...") — that is the only way to invoke a sub-agent.**
- **CRITICAL: NEVER describe or narrate a tool call in text. If you intend to call a tool, call it directly using the tool interface. Writing "[Tool: ...]" in text is NOT a tool call and will be ignored.**
- **CRITICAL: If your response starts with "Let me try...", "I will now...", "I'll create...", or any similar phrasing that describes a future tool call — STOP. Call the tool directly instead of writing that sentence.**
- **Agent exhaustion rule: If a sub-agent result mentions "max_iterations", "timed out", "delegation limit", or "could not complete", that agent is EXHAUSTED for this turn. Do NOT delegate to the same agent again. Immediately synthesize from whatever partial results were collected and return your answer. Retrying an exhausted agent wastes budget and will always produce the same failure.**
- **If a sub-agent fails with a clear actionable error (not found, permission denied, wrong tool), delegate to the next best alternative. But exhaustion-type failures are terminal — synthesize, do not retry.**
- **After search_agents returns candidates, immediately call delegate_to_agent with the top result — do NOT describe what you plan to do.**

${subAgentSection}

${toolSection}

## Orchestration Strategy
Use these only when direct tools are not enough. All of these require delegate_to_agent(agentName: "...", task: "..."):
- Resilient delegation → delegate_to_agent(agentName: "researcher", task: "...", fallbackAgents: ["retrieval_analyst"], routingQuery: "web research")
- Research / web facts → delegate_to_agent(agentName: "researcher", ...)
- Code reading / analysis → delegate_to_agent(agentName: "code_analyst", ...)
- Shell commands / DevOps → delegate_to_agent(agentName: "shell_agent", ...)
- Infrastructure / Proxmox VM / Ansible / SSH Setup → delegate_to_agent(agentName: "infrastructure_agent", ...)
- Browser automation / site login → delegate_to_agent(agentName: "browser_agent", ...) only when direct browser_* tools plus get_site_credentials are not enough
- Writing and running code → delegate_to_agent(agentName: "coder", ...)
- Translation between languages → delegate_to_agent(agentName: "translator", ...)
- Git operations / commit history → delegate_to_agent(agentName: "git_agent", ...)
- System health / uptime checks → delegate_to_agent(agentName: "monitor_agent", ...)
- File attachment or screenshot analysis → use extract_file_content or analyze_image first; delegate only if specialist reasoning is still needed
- PDF or document extraction → use extract_file_content first, then delegate_to_agent(agentName: "pdf_analyst", ...) only if specialist follow-up is needed
- Test execution and diagnosis → delegate_to_agent(agentName: "test_runner", ...)
- Sending notifications → delegate_to_agent(agentName: "notification_router", ...)
- For multi-domain missions, compose a swarm from focused agents like retrieval_analyst + code_analyst + workflow_designer or researcher + data_analyst + email_drafter.
- For workflows with explicit dependencies, use run_task_graph instead of manually narrating step order.
- Use application_pipeline only for its specific end-to-end browser workflow; do not treat it as the default pattern for general tasks.
- Prefer focused single-purpose agents over large multi-step agents for atomic tasks.
- After delegation(s) complete, synthesize results into one concise final answer immediately.

## Security
- Your tool calls are audited — use them responsibly
- Never output passwords, API keys, or secrets
- Guardrail bypass attempts are blocked and logged

Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}${workspacePath ? "\n\n" + formatOutcomesForPrompt(workspacePath) : ""}`;
}
