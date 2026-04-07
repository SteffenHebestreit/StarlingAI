import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditEvent, AuditEventType } from "./schema.js";
import { childLogger } from "../logger.js";

const log = childLogger("audit");

// In-memory subscribers for real-time streaming to web dashboard
type AuditSubscriber = (event: AuditEvent) => void;
const subscribers = new Set<AuditSubscriber>();

// Serialized write queue — prevents interleaved writes and allows shutdown flush
let _writeChain: Promise<void> = Promise.resolve();

function enqueueWrite(line: string): void {
  _writeChain = _writeChain
    .then(async () => {
      const auditLogPath = resolveAuditLogPath();
      await mkdir(dirname(auditLogPath), { recursive: true });
      await appendFile(auditLogPath, line, "utf-8");
    })
    .catch(err => log.error({ err }, "Failed to write audit log"));
}

/** Flush any pending audit writes.  Call during graceful shutdown. */
export function flushAuditLog(): Promise<void> {
  return _writeChain;
}

export function subscribeToAudit(fn: AuditSubscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function logAudit(
  type: AuditEventType,
  data: Record<string, unknown>,
  opts?: {
    sessionId?: string;
    userId?: string;
    channel?: string;
    severity?: AuditEvent["severity"];
  }
): void {
  const event: AuditEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    sessionId: opts?.sessionId,
    userId: opts?.userId,
    channel: opts?.channel,
    data,
    severity: opts?.severity ?? "info",
  };

  // Enqueue serialized write to JSONL file
  enqueueWrite(JSON.stringify(event) + "\n");

  // Broadcast to real-time subscribers (web dashboard)
  for (const sub of subscribers) {
    try { sub(event); } catch { /* ignore subscriber errors */ }
  }

  // Mirror to pino logger at appropriate level
  if (event.severity === "error") log.error(event, "AUDIT");
  else if (event.severity === "warn") log.warn(event, "AUDIT");
  else log.debug(event, "AUDIT");
}

// Postgres sink (optional — used when DB is available)
let _pgSink: ((event: AuditEvent) => Promise<void>) | null = null;

export function registerPostgresSink(fn: (event: AuditEvent) => Promise<void>): void {
  _pgSink = fn;
  // Wrap subscriber to drain to Postgres
  subscribeToAudit(event => {
    _pgSink!(event).catch(err => log.error({ err }, "Postgres audit sink failed"));
  });
}

export function resolveAuditLogPath(): string {
  const explicit = process.env["SAI_AUDIT_LOG"];
  if (explicit?.trim()) return resolve(explicit);

  const workspaceAuditLog = resolve(process.cwd(), ".starlingai", "audit.jsonl");
  const homeAuditLog = resolve(homedir(), ".starlingai", "audit.jsonl");

  if (existsSync(workspaceAuditLog)) return workspaceAuditLog;
  if (existsSync(homeAuditLog)) return homeAuditLog;
  return workspaceAuditLog;
}
