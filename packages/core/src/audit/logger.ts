import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditEvent, AuditEventType } from "./schema.js";
import { childLogger } from "../logger.js";
import { scanOutput } from "../guardrails/output.js";

import { PRODUCT } from "../product/index.js";

const log = childLogger("audit");
// Exact/word-boundary sensitive names only. Do NOT match generic substrings
// such as `promptTokens` / `completionTokens`, which are safe numeric telemetry.
const SENSITIVE_AUDIT_KEY = /^(?:authorization|cookie|password|passwd|pwd|passphrase|secret|token|api[_-]?(?:key|token)|apikey|credential|credentials|private[_-]?key|access[_-]?key|auth(?:orization)?|.*(?:_secret|_token|_password|_credential|_api_key|_private_key))$/i;

/**
 * Audit events cross several persistence and streaming boundaries. Sanitize data
 * once here so no call site, extension, sink, or subscriber can accidentally
 * persist a credential-shaped value. Keys are redacted conservatively; ordinary
 * strings are passed through the shared secret scanner (including known env values).
 */
export function sanitizeAuditData(value: unknown, key = ""): unknown {
  if (SENSITIVE_AUDIT_KEY.test(key)) return "[REDACTED:sensitive-field]";
  if (typeof value === "string") {
    // Audit logging must never turn a non-critical worker failure into a
    // gateway failure. Isolated plugin workers deliberately lack the complete
    // application configuration that the shared scanner lazily initializes.
    try {
      const scan = scanOutput(value);
      return scan.redacted ?? value;
    } catch {
      // Key-based redaction above still protects structured credentials. Do
      // not reject operational events merely because optional scanner setup is
      // unavailable in a least-privilege child process.
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeAuditData(entry));
  if (value && typeof value === "object") {
    // Only recurse into plain objects. Dates, Buffers/TypedArrays, Maps and Sets
    // must pass through untouched so JSON.stringify serializes them natively
    // (a Date via toJSON → ISO string, a Buffer → {type:"Buffer",data:[…]}); an
    // Object.entries rebuild would flatten a Date to {} and explode a Buffer.
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entryValue]) => [entryKey, sanitizeAuditData(entryValue, entryKey)]));
  }
  return value;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Value-scan a free-form string field (not key-redacted). */
function sanitizeAuditString(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    return scanOutput(value).redacted ?? value;
  } catch {
    return value;
  }
}

// In-memory subscribers for real-time streaming to web dashboard
type AuditSubscriber = (event: AuditEvent) => void;
const subscribers = new Set<AuditSubscriber>();

// Serialized write queue — prevents interleaved writes and allows shutdown flush
let _writeChain: Promise<void> = Promise.resolve();
let _pendingWrites = 0;
let _failedWrites = 0;
let _lastWriteFailureAt: string | undefined;

export interface AuditWriteStatus {
  pendingWrites: number;
  failedWrites: number;
  lastWriteFailureAt?: string;
}

/** Lightweight health signal for readiness/metrics consumers. */
export function getAuditWriteStatus(): AuditWriteStatus {
  return { pendingWrites: _pendingWrites, failedWrites: _failedWrites, lastWriteFailureAt: _lastWriteFailureAt };
}

function enqueueWrite(line: string): void {
  _pendingWrites++;
  _writeChain = _writeChain
    .then(async () => {
      const auditLogPath = resolveAuditLogPath();
      await mkdir(dirname(auditLogPath), { recursive: true });
      await appendFile(auditLogPath, line, "utf-8");
    })
    .catch(err => {
      _failedWrites++;
      _lastWriteFailureAt = new Date().toISOString();
      log.error({ err }, "Failed to write audit log");
    })
    .finally(() => { _pendingWrites--; });
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
    // sessionId/userId are identity keys recorded verbatim for audit filtering.
    // `channel` is free-form and can carry a credential-shaped value, so scan it.
    channel: sanitizeAuditString(opts?.channel),
    data: sanitizeAuditData(data) as Record<string, unknown>,
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

  const workspaceAuditLog = resolve(process.cwd(), PRODUCT.stateDirName, "audit.jsonl");
  const homeAuditLog = resolve(homedir(), PRODUCT.stateDirName, "audit.jsonl");

  if (existsSync(workspaceAuditLog)) return workspaceAuditLog;
  if (existsSync(homeAuditLog)) return homeAuditLog;
  return workspaceAuditLog;
}
