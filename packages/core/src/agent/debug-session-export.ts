import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AuditEvent } from "../audit/schema.js";
import { flushAuditLog, resolveAuditLogPath } from "../audit/logger.js";
import {
  getSessionRecord,
  getSessionTranscript,
  type SessionHistoryMessage,
  type SessionTranscriptMessage,
} from "./session.js";

export async function buildSessionAuditMarkdown(sessionId: string): Promise<string> {
  const session = getSessionRecord(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const auditEvents = await readSessionAuditEvents(sessionId, session.getWorkspacePath());
  const relatedSubSessions = [...new Set(
    auditEvents
      .map((event) => event.sessionId)
      .filter((value): value is string => typeof value === "string" && value.startsWith(`sub:${sessionId}:`)),
  )];

  const lines: string[] = [
    "# StarlingAI Session Audit Export",
    "",
    `- Session: ${session.id}`,
    `- Channel: ${session.channel}`,
    `- User: ${session.userId ?? "(none)"}`,
    `- Created: ${session.createdAt.toISOString()}`,
    `- Updated: ${session.getUpdatedAt().toISOString()}`,
    `- Status: ${session.isArchived() ? `Archived (${session.getArchivedAt()?.toISOString() ?? "unknown"})` : "Active"}`,
    `- Turns: ${session.getTurnCount()}`,
    `- Workspace: ${session.getWorkspacePath()}`,
    `- Audit events: ${auditEvents.length}`,
    `- Related sub-sessions: ${relatedSubSessions.length > 0 ? relatedSubSessions.join(", ") : "(none)"}`,
    "",
    "## Audit Events",
    "",
  ];

  if (auditEvents.length === 0) {
    lines.push("No matching audit events were found.", "");
  } else {
    auditEvents.forEach((event, index) => appendAuditEvent(lines, event, index + 1));
  }

  return lines.join("\n");
}

export async function buildSessionDebugMarkdown(sessionId: string): Promise<string> {
  const session = getSessionRecord(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const transcriptPage = getSessionTranscript(sessionId);
  const transcript = transcriptPage?.transcript ?? [];
  const rawHistory = [...session.getHistory()];
  const auditEvents = await readSessionAuditEvents(sessionId, session.getWorkspacePath());
  const relatedSubSessions = [...new Set(
    auditEvents
      .map((event) => event.sessionId)
      .filter((value): value is string => typeof value === "string" && value.startsWith(`sub:${sessionId}:`)),
  )];

  const lines: string[] = [
    "# StarlingAI Debug Session Export",
    "",
    `- Session: ${session.id}`,
    `- Channel: ${session.channel}`,
    `- User: ${session.userId ?? "(none)"}`,
    `- Created: ${session.createdAt.toISOString()}`,
    `- Updated: ${session.getUpdatedAt().toISOString()}`,
    `- Status: ${session.isArchived() ? `Archived (${session.getArchivedAt()?.toISOString() ?? "unknown"})` : "Active"}`,
    `- Turns: ${session.getTurnCount()}`,
    `- Workspace: ${session.getWorkspacePath()}`,
    `- Transcript messages: ${transcript.length}`,
    `- Raw history messages: ${rawHistory.length}`,
    `- Audit events: ${auditEvents.length}`,
    `- Related sub-sessions: ${relatedSubSessions.length > 0 ? relatedSubSessions.join(", ") : "(none)"}`,
    "",
    "## System Prompt",
    "",
    "```text",
    session.getSystemPrompt(),
    "```",
    "",
    "## Transcript",
    "",
  ];

  if (transcript.length === 0) {
    lines.push("No transcript messages recorded.", "");
  } else {
    for (const message of transcript) {
      appendTranscriptMessage(lines, message);
    }
  }

  lines.push("## Raw Session History", "");
  if (rawHistory.length === 0) {
    lines.push("No raw session history recorded.", "");
  } else {
    rawHistory.forEach((message, index) => appendRawHistoryMessage(lines, message, index + 1));
  }

  lines.push("## Audit Events", "");
  if (auditEvents.length === 0) {
    lines.push("No matching audit events were found.", "");
  } else {
    auditEvents.forEach((event, index) => appendAuditEvent(lines, event, index + 1));
  }

  return lines.join("\n");
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

async function readSessionAuditEvents(sessionId: string, workspacePath?: string): Promise<AuditEvent[]> {
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
    for (const event of readAuditEventsFromFile(candidate)) {
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

function readAuditEventsFromFile(filePath: string): AuditEvent[] {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => safeParseAuditEvent(line))
    .filter((event): event is AuditEvent => event !== null);
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