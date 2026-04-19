import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { AuditEvent } from "../audit/schema.js";
import { flushAuditLog, resolveAuditLogPath } from "../audit/logger.js";
import { isSessionTurnActive } from "./warden.js";
import {
  getSessionRecord,
  getSessionTranscript,
  type SessionHistoryMessage,
  type SessionTranscriptMessage,
} from "./session.js";

export class SessionExportBusyError extends Error {
  constructor(sessionId: string) {
    super(`Session export is unavailable while the session is still running: ${sessionId}`);
    this.name = "SessionExportBusyError";
  }
}

interface SessionExportSnapshot {
  id: string;
  channel: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  turns: number;
  workspacePath: string;
  systemPrompt: string;
  transcript: SessionTranscriptMessage[];
  rawHistory: SessionHistoryMessage[];
}

const AUDIT_PARSE_YIELD_INTERVAL = 250;
const MARKDOWN_APPEND_YIELD_INTERVAL = 25;

export async function buildSessionAuditMarkdown(sessionId: string): Promise<string> {
  const snapshot = captureSessionExportSnapshot(sessionId);
  return buildSessionAuditMarkdownFromSnapshot(snapshot);
}

export async function buildSessionDebugMarkdown(sessionId: string): Promise<string> {
  const snapshot = captureSessionExportSnapshot(sessionId);
  return buildSessionDebugMarkdownFromSnapshot(snapshot);
}

export async function buildSessionAuditMarkdownDetached(sessionId: string): Promise<string> {
  const snapshot = captureSessionExportSnapshot(sessionId, { allowActive: true });
  return buildSessionAuditMarkdownFromSnapshot(snapshot);
}

export async function buildSessionDebugMarkdownDetached(sessionId: string): Promise<string> {
  const snapshot = captureSessionExportSnapshot(sessionId, { allowActive: true });
  return buildSessionDebugMarkdownFromSnapshot(snapshot);
}

function describeTranscriptContent(message: SessionTranscriptMessage): string {
  const content = message.content.trim();
  if (content) {
    return content;
  }

  if (!message.toolCalls?.length) {
    return "(no text content)";
  }

  const toolNames = [...new Set(message.toolCalls.map((toolCall) => toolCall.name).filter(Boolean))];
  if (toolNames.length === 0) {
    return "(no text content)";
  }

  const label = toolNames.length === 1 ? "Requested tool" : "Requested tools";
  return [
    "Tool-only assistant turn.",
    `${label}: ${toolNames.join(", ")}`,
  ].join("\n");
}

function appendTranscriptMessage(lines: string[], message: SessionTranscriptMessage): void {
  lines.push(`### ${message.role} - ${message.timestamp}`);
  lines.push("");
  lines.push(describeTranscriptContent(message));
  lines.push("");

  if (message.toolCalls?.length) {
    lines.push("#### Tool Calls", "");
    for (const toolCall of message.toolCalls) {
      lines.push(`- ${toolCall.name}`);
      lines.push("");
      lines.push("```json");
      lines.push(safeJson(toolCall.args));
      lines.push("```");
      if (toolCall.result) {
        lines.push("");
        lines.push("```text");
        lines.push(toolCall.result);
        lines.push("```");
      }
      if (toolCall.metadata) {
        lines.push("");
        lines.push("```json");
        lines.push(safeJson(toolCall.metadata));
        lines.push("```");
      }
      lines.push("");
    }
  }

  if (message.swarmState) {
    lines.push("#### Swarm State", "");
    lines.push("```json");
    lines.push(safeJson(message.swarmState));
    lines.push("```");
    lines.push("");
  }

  lines.push("---", "");
}

function appendRawHistoryMessage(lines: string[], message: SessionHistoryMessage, ordinal: number): void {
  lines.push(`### ${ordinal}. ${message.role} - ${message.timestamp}`);
  lines.push("");

  const content = typeof message.content === "string"
    ? message.content
    : safeJson(message.content);
  lines.push("```text");
  lines.push(content || "(no text content)");
  lines.push("```");
  lines.push("");

  if (message.tool_call_id) {
    lines.push(`- tool_call_id: ${message.tool_call_id}`);
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    lines.push("- tool_calls:");
    lines.push("```json");
    lines.push(safeJson(message.tool_calls));
    lines.push("```");
  }

  if (message.metadata && Object.keys(message.metadata).length > 0) {
    lines.push("- metadata:");
    lines.push("```json");
    lines.push(safeJson(message.metadata));
    lines.push("```");
  }

  lines.push("---", "");
}

function appendAuditEvent(lines: string[], event: AuditEvent, ordinal: number): void {
  lines.push(`### ${ordinal}. ${event.timestamp} - ${event.type}`);
  lines.push("");
  lines.push(`- severity: ${event.severity}`);
  lines.push(`- session: ${event.sessionId ?? "(none)"}`);
  lines.push(`- channel: ${event.channel ?? "(none)"}`);
  lines.push("");
  lines.push("```json");
  lines.push(safeJson(event));
  lines.push("```");
  lines.push("");
}

async function buildSessionAuditMarkdownFromSnapshot(snapshot: SessionExportSnapshot): Promise<string> {
  const auditEvents = await readSessionAuditEventsAsync(snapshot.id, snapshot.workspacePath);
  const relatedSubSessions = getRelatedSubSessions(snapshot.id, auditEvents);

  const lines: string[] = [
    "# StarlingAI Session Audit Export",
    "",
    `- Session: ${snapshot.id}`,
    `- Channel: ${snapshot.channel}`,
    `- User: ${snapshot.userId ?? "(none)"}`,
    `- Created: ${snapshot.createdAt}`,
    `- Updated: ${snapshot.updatedAt}`,
    `- Status: ${snapshot.archivedAt ? `Archived (${snapshot.archivedAt})` : "Active"}`,
    `- Turns: ${snapshot.turns}`,
    `- Workspace: ${snapshot.workspacePath}`,
    `- Audit events: ${auditEvents.length}`,
    `- Related sub-sessions: ${relatedSubSessions.length > 0 ? relatedSubSessions.join(", ") : "(none)"}`,
    "",
    "## Audit Events",
    "",
  ];

  if (auditEvents.length === 0) {
    lines.push("No matching audit events were found.", "");
  } else {
    await appendAuditEventsAsync(lines, auditEvents);
  }

  return lines.join("\n");
}

async function buildSessionDebugMarkdownFromSnapshot(snapshot: SessionExportSnapshot): Promise<string> {
  const auditEvents = await readSessionAuditEventsAsync(snapshot.id, snapshot.workspacePath);
  const relatedSubSessions = getRelatedSubSessions(snapshot.id, auditEvents);

  const lines: string[] = [
    "# StarlingAI Debug Session Export",
    "",
    `- Session: ${snapshot.id}`,
    `- Channel: ${snapshot.channel}`,
    `- User: ${snapshot.userId ?? "(none)"}`,
    `- Created: ${snapshot.createdAt}`,
    `- Updated: ${snapshot.updatedAt}`,
    `- Status: ${snapshot.archivedAt ? `Archived (${snapshot.archivedAt})` : "Active"}`,
    `- Turns: ${snapshot.turns}`,
    `- Workspace: ${snapshot.workspacePath}`,
    `- Transcript messages: ${snapshot.transcript.length}`,
    `- Raw history messages: ${snapshot.rawHistory.length}`,
    `- Audit events: ${auditEvents.length}`,
    `- Related sub-sessions: ${relatedSubSessions.length > 0 ? relatedSubSessions.join(", ") : "(none)"}`,
    "",
    "## System Prompt",
    "",
    "```text",
    snapshot.systemPrompt,
    "```",
    "",
    "## Transcript",
    "",
  ];

  if (snapshot.transcript.length === 0) {
    lines.push("No transcript messages recorded.", "");
  } else {
    await appendTranscriptMessagesAsync(lines, snapshot.transcript);
  }

  lines.push("## Raw Session History", "");
  if (snapshot.rawHistory.length === 0) {
    lines.push("No raw session history recorded.", "");
  } else {
    await appendRawHistoryMessagesAsync(lines, snapshot.rawHistory);
  }

  lines.push("## Audit Events", "");
  if (auditEvents.length === 0) {
    lines.push("No matching audit events were found.", "");
  } else {
    await appendAuditEventsAsync(lines, auditEvents);
  }

  return lines.join("\n");
}

function captureSessionExportSnapshot(sessionId: string, opts?: { allowActive?: boolean }): SessionExportSnapshot {
  const session = getSessionRecord(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (!opts?.allowActive && isSessionTurnActive(sessionId)) {
    throw new SessionExportBusyError(sessionId);
  }

  const transcriptPage = getSessionTranscript(sessionId);

  return {
    id: session.id,
    channel: session.channel,
    userId: session.userId,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.getUpdatedAt().toISOString(),
    archivedAt: session.getArchivedAt()?.toISOString(),
    turns: session.getTurnCount(),
    workspacePath: session.getWorkspacePath(),
    systemPrompt: session.getSystemPrompt(),
    transcript: transcriptPage?.transcript ?? [],
    rawHistory: [...session.getHistory()],
  };
}

function getRelatedSubSessions(sessionId: string, auditEvents: AuditEvent[]): string[] {
  return [...new Set(
    auditEvents
      .map((event) => event.sessionId)
      .filter((value): value is string => typeof value === "string" && value.startsWith(`sub:${sessionId}:`)),
  )];
}

async function appendTranscriptMessagesAsync(lines: string[], transcript: SessionTranscriptMessage[]): Promise<void> {
  for (let index = 0; index < transcript.length; index += 1) {
    appendTranscriptMessage(lines, transcript[index]!);
    if ((index + 1) % MARKDOWN_APPEND_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }
}

async function appendRawHistoryMessagesAsync(lines: string[], rawHistory: SessionHistoryMessage[]): Promise<void> {
  for (let index = 0; index < rawHistory.length; index += 1) {
    appendRawHistoryMessage(lines, rawHistory[index]!, index + 1);
    if ((index + 1) % MARKDOWN_APPEND_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }
}

async function appendAuditEventsAsync(lines: string[], auditEvents: AuditEvent[]): Promise<void> {
  for (let index = 0; index < auditEvents.length; index += 1) {
    appendAuditEvent(lines, auditEvents[index]!, index + 1);
    if ((index + 1) % MARKDOWN_APPEND_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }
}

async function readSessionAuditEventsAsync(sessionId: string, workspacePath?: string): Promise<AuditEvent[]> {
  await flushAuditLog();

  const candidates = [
    process.env["SAI_AUDIT_LOG"]?.trim(),
    resolveAuditLogPath(),
    resolve(process.cwd(), ".starlingai", "audit.jsonl"),
    resolve(homedir(), ".starlingai", "audit.jsonl"),
    workspacePath ? resolve(workspacePath, ".starlingai", "audit.jsonl") : undefined,
  ].filter((value): value is string => Boolean(value));

  const seen = new Set<string>();
  const events: AuditEvent[] = [];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    for (const event of await readMatchingAuditEventsFromFileAsync(candidate, sessionId)) {
      if (event.sessionId !== sessionId && !event.sessionId?.startsWith(`sub:${sessionId}:`)) {
        continue;
      }
      if (seen.has(event.id)) {
        continue;
      }
      seen.add(event.id);
      events.push(event);
    }
  }

  return events.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

async function readMatchingAuditEventsFromFileAsync(filePath: string, sessionId: string): Promise<AuditEvent[]> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const events: AuditEvent[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.trim().length === 0) continue;

    const event = safeParseAuditEvent(line);
    if (!event) continue;
    if (event.sessionId !== sessionId && !event.sessionId?.startsWith(`sub:${sessionId}:`)) {
      continue;
    }

    events.push(event);

    if ((index + 1) % AUDIT_PARSE_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  return events;
}

function safeParseAuditEvent(line: string): AuditEvent | null {
  try {
    return JSON.parse(line) as AuditEvent;
  } catch {
    return null;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}