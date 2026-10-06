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
/**
 * Binary payloads that belong on disk, not in the audit log.
 *
 * A single 1024x1024 PNG is ~1.5 MB, which becomes ~2 MB of base64 — and it was being
 * written into `tool_call_completed` metadata AND again into the delegation's `artifacts`,
 * so one two-minute image session put 3.89 MB into audit.jsonl and the file reached 8.4 MB.
 * That is not a log any operator can read, and every later grep pays for it.
 *
 * The bytes are not lost: they are already on disk, and the same object carries the
 * `outputPath` they were written to. So the log keeps the pointer and drops the payload,
 * which is the thing an audit trail actually needs — WHICH image, not the image.
 *
 * Applied by shape rather than by field name, so a screenshot, an upload or the next
 * producer nobody has written yet is covered without being added to a list.
 */
const AUDIT_INLINE_PAYLOAD_MAX = 2048;
const DATA_URL_PREFIX = /^data:[^;,]*;base64,/;
/** Base64 alphabet plus the line breaks some encoders insert, and nothing else. */
const BARE_BASE64 = /^[A-Za-z0-9+/=\r\n]+$/;

function summarizeInlinePayload(value: string, siblingPath?: string): string {
  // Measure the PAYLOAD, not the `data:image/png;base64,` preamble, so the number in the
  // log is the size of the thing on disk rather than the size of the string we dropped.
  const payload = value.replace(DATA_URL_PREFIX, "");
  const bytes = Math.round((payload.length * 3) / 4);
  const where = siblingPath ? ` -> ${siblingPath}` : "";
  return `[omitted: inline ${bytes.toLocaleString("en-US")}-byte payload${where}]`;
}

/** A long, opaque blob: a data: URL, or bare base64 with no whitespace. */
function looksLikeInlinePayload(value: string): boolean {
  if (value.length <= AUDIT_INLINE_PAYLOAD_MAX) return false;
  if (DATA_URL_PREFIX.test(value)) return true;
  return BARE_BASE64.test(value);
}

export function sanitizeAuditData(value: unknown, key = "", siblingPath?: string): unknown {
  if (SENSITIVE_AUDIT_KEY.test(key)) return "[REDACTED:sensitive-field]";
  if (typeof value === "string" && looksLikeInlinePayload(value)) {
    return summarizeInlinePayload(value, siblingPath);
  }
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
    const record = value as Record<string, unknown>;
    // Pass the sibling path down so a dropped payload names the file it was written to,
    // rather than becoming an anonymous "[omitted]" nobody can trace back to an artifact.
    const path = typeof record["outputPath"] === "string" ? record["outputPath"]
      : typeof record["path"] === "string" ? record["path"]
      : undefined;
    return Object.fromEntries(Object.entries(record)
      .map(([entryKey, entryValue]) => [entryKey, sanitizeAuditData(entryValue, entryKey, path)]));
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

/**
 * Lines waiting for the next write. One write takes everything queued by the time it runs: a
 * mkdir + append per line fell hours behind on the bind-mounted workspace when a runaway routing
 * loop logged ~12 events a second (session ffe08297, 2026-10-06) — the file stopped at 08:08 while
 * the gateway went on queueing in memory.
 */
let _batch: string[] = [];

function enqueueWrite(line: string): void {
  _pendingWrites++;
  _batch.push(line);
  // A write for the current batch is already chained; it will take this line too.
  if (_batch.length > 1) return;
  _writeChain = _writeChain.then(async () => {
    const lines = _batch;
    _batch = [];
    try {
      const auditLogPath = resolveAuditLogPath();
      await mkdir(dirname(auditLogPath), { recursive: true });
      await appendFile(auditLogPath, lines.join(""), "utf-8");
    } catch (err) {
      _failedWrites += lines.length;
      _lastWriteFailureAt = new Date().toISOString();
      log.error({ err, lines: lines.length }, "Failed to write audit log");
    } finally {
      _pendingWrites -= lines.length;
    }
  });
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
