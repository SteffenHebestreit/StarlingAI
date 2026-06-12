/**
 * Computer-use session recording & replay (Stage 9F)
 *
 * Records every action and screenshot during a computer-use session into
 * a JSONL file on disk. Recordings can later be replayed for debugging,
 * evaluation, or demonstration.
 *
 * Format: One JSON line per event, ordered by `ts`.
 */

import { mkdir, appendFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

import { PRODUCT } from "../product/index.js";

const log = childLogger("agent:computer-recording");

// ── Types ─────────────────────────────────────────────────────────────────────

export type RecordingEventType =
  | "session_started"
  | "session_stopped"
  | "action"
  | "action_result"
  | "screenshot"
  | "vision_analysis"
  | "intervention"
  | "recovery_attempt";

export interface RecordingEvent {
  ts: number;
  type: RecordingEventType;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface RecordingMeta {
  sessionId: string;
  adapter: string;
  startedAt: number;
  stoppedAt?: number;
  eventCount: number;
  durationMs?: number;
}

// ── In-memory state ───────────────────────────────────────────────────────────

/** sessionId → file handle info */
const _activeRecordings = new Map<string, {
  filePath: string;
  eventCount: number;
  startedAt: number;
}>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start recording a computer session.
 * Creates a JSONL file under the workspace's `.starlingai/recordings/` directory.
 */
export async function startRecording(sessionId: string, adapter: string): Promise<string> {
  if (_activeRecordings.has(sessionId)) {
    log.warn({ sessionId }, "Recording already active — skipping");
    return _activeRecordings.get(sessionId)!.filePath;
  }

  const config = getConfig();
  const cuConfig = (config as Record<string, unknown>)["computerUse"] as Record<string, unknown> | undefined;
  const enabled = cuConfig?.["recordingEnabled"] !== false;

  if (!enabled) {
    log.debug({ sessionId }, "Recording disabled in config");
    return "";
  }

  const recordingsDir = resolve(config.workspacePath, PRODUCT.stateDirName, "recordings");
  await mkdir(recordingsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = resolve(recordingsDir, `${sessionId.slice(0, 12)}_${timestamp}.jsonl`);

  _activeRecordings.set(sessionId, {
    filePath,
    eventCount: 0,
    startedAt: Date.now(),
  });

  await appendEvent(sessionId, {
    ts: Date.now(),
    type: "session_started",
    sessionId,
    data: { adapter },
  });

  log.info({ sessionId, filePath }, "Recording started");
  return filePath;
}

/**
 * Record an event to the session's recording file.
 */
export async function recordEvent(
  sessionId: string,
  type: RecordingEventType,
  data: Record<string, unknown>,
): Promise<void> {
  if (!_activeRecordings.has(sessionId)) return;

  await appendEvent(sessionId, {
    ts: Date.now(),
    type,
    sessionId,
    data,
  });
}

/**
 * Stop recording and finalize the session file.
 */
export async function stopRecording(sessionId: string): Promise<RecordingMeta | null> {
  const recording = _activeRecordings.get(sessionId);
  if (!recording) return null;

  const now = Date.now();

  await appendEvent(sessionId, {
    ts: now,
    type: "session_stopped",
    sessionId,
    data: {},
  });

  const meta: RecordingMeta = {
    sessionId,
    adapter: "unknown",
    startedAt: recording.startedAt,
    stoppedAt: now,
    eventCount: recording.eventCount,
    durationMs: now - recording.startedAt,
  };

  _activeRecordings.delete(sessionId);
  log.info({ sessionId, events: meta.eventCount, durationMs: meta.durationMs }, "Recording stopped");
  return meta;
}

/**
 * Load a recording file and parse all events.
 */
export async function loadRecording(filePath: string): Promise<RecordingEvent[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  return lines.map(line => JSON.parse(line) as RecordingEvent);
}

/**
 * List all active recordings.
 */
export function listActiveRecordings(): Array<{ sessionId: string; filePath: string; eventCount: number }> {
  return Array.from(_activeRecordings.entries()).map(([sessionId, info]) => ({
    sessionId,
    filePath: info.filePath,
    eventCount: info.eventCount,
  }));
}

/**
 * Reset for tests.
 */
export function resetRecordingsForTests(): void {
  _activeRecordings.clear();
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function appendEvent(sessionId: string, event: RecordingEvent): Promise<void> {
  const recording = _activeRecordings.get(sessionId);
  if (!recording) return;

  const line = JSON.stringify(event) + "\n";

  try {
    await mkdir(dirname(recording.filePath), { recursive: true });
    await appendFile(recording.filePath, line, "utf-8");
    recording.eventCount++;
  } catch (err) {
    log.error({ sessionId, err: (err as Error).message }, "Failed to write recording event");
  }
}
