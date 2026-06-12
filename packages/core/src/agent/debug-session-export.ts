import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
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

import { PRODUCT } from "../product/index.js";

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

// Yield to the event loop after this many lines while streaming the audit
// file. Lower numbers keep /healthz and in-flight LLM streams responsive at
// the cost of slightly slower audit exports; higher numbers favour throughput.
// 100 is a good balance for multi-MB audit logs on a busy gateway.
const AUDIT_PARSE_YIELD_INTERVAL = 100;
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
    resolve(process.cwd(), PRODUCT.stateDirName, "audit.jsonl"),
    resolve(homedir(), PRODUCT.stateDirName, "audit.jsonl"),
    workspacePath ? resolve(workspacePath, PRODUCT.stateDirName, "audit.jsonl") : undefined,
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
  // Stream line-by-line instead of slurping the whole audit.jsonl into memory.
  // The audit log accumulates indefinitely and a `readFile + split` on a busy
  // gateway can block the event loop for seconds, which causes Docker's
  // /healthz check to fail mid-run when an operator triggers an audit export.
  //
  // Cheap substring pre-filter: skip JSON.parse entirely for lines that don't
  // mention the session id. The audit format always embeds the session id as
  // `"sessionId":"<id>"`, so a literal `.includes` is safe and dramatically
  // reduces CPU when the file is dominated by other sessions.
  const sessionMarker = `"sessionId":"${sessionId}"`;
  const subSessionMarker = `"sessionId":"sub:${sessionId}:`;
  const events: AuditEvent[] = [];

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  let processed = 0;
  try {
    for await (const rawLine of reader) {
      processed += 1;
      if ((processed % AUDIT_PARSE_YIELD_INTERVAL) === 0) {
        // Hand control back to the event loop so /healthz, in-flight LLM
        // streams, and audit writes don't starve while we drain the file.
        await yieldToEventLoop();
      }

      if (!rawLine) continue;
      // Cheap pre-filter — avoids JSON.parse on the (typically large) majority
      // of lines that belong to other sessions.
      if (!rawLine.includes(sessionMarker) && !rawLine.includes(subSessionMarker)) continue;

      const event = safeParseAuditEvent(rawLine);
      if (!event) continue;
      if (event.sessionId !== sessionId && !event.sessionId?.startsWith(`sub:${sessionId}:`)) {
        continue;
      }

      events.push(event);
    }
  } finally {
    reader.close();
    stream.destroy();
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