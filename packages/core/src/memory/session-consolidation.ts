/**
 * End-of-session memory consolidation — the missing link that turns short-term
 * session knowledge into durable long-term memory.
 *
 * Session shared-facts live in the collective-memory layer (Redis, keyed by
 * sessionId) and are lost when the session closes unless an agent explicitly
 * called memory_promote. This pass runs automatically when a session is
 * archived: it harvests the session's durable-worthy shared-facts and promotes
 * them into workspace memory (embedded on write via storeWorkspaceMemoryRecord),
 * so the swarm accumulates knowledge across sessions.
 *
 * Deterministic and bounded — no LLM call, so it is safe to run fire-and-forget
 * from the archival path. Credential-scrubbed, deduped against existing durable
 * memory, and capped per session so durable memory never bloats.
 */
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { readAllFacts } from "../swarm/memory.js";
import { storeWorkspaceMemoryRecord, listWorkspaceMemoryRecords } from "./service.js";

const log = childLogger("memory:session-consolidation");

// Mirror the credential guard used by the trajectory cache and skill store
// (catches "password: x", "bearer=y" inside the value).
const CREDENTIAL_RE = /(?:password|secret|token|api[_-]?key|bearer|authorization)\s*[:=]\s*\S+/i;
// A fact KEYED like a secret must never be persisted, regardless of value shape
// (e.g. a shared fact "api_token" → "<value>"). This is stricter than scanning
// only the value, which requires an explicit key:value form.
const SECRET_KEY_RE = /(?:password|passwd|secret|token|api[_-]?key|apikey|credential|bearer|private[_-]?key|access[_-]?key|auth[_-]?token)/i;
// Fact keys whose value is inherently transient and not worth persisting.
const TRANSIENT_KEY_RE = /^(?:_|status|progress|state|tmp|temp|current_step|iteration|scratch|step_)/i;
const MAX_FACT_CHARS = 4_000;

export interface SessionConsolidationResult {
  promoted: number;
  skipped: number;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Promote durable-worthy shared-facts from an archived session into workspace
 * memory. Never throws — returns counts and logs best-effort.
 */
export async function consolidateSessionMemory(opts: {
  sessionId: string;
  workspacePath: string;
  channel?: string;
  turnCount?: number;
}): Promise<SessionConsolidationResult> {
  const result: SessionConsolidationResult = { promoted: 0, skipped: 0 };
  try {
    const cfg = getConfig().memory;
    if (!cfg.autoConsolidateSessions) return result;
    if ((opts.turnCount ?? 0) < 1) return result;

    let facts: Record<string, string> = {};
    try {
      facts = await readAllFacts(opts.sessionId);
    } catch {
      return result;
    }
    const entries = Object.entries(facts);
    if (entries.length === 0) return result;

    // Snapshot existing durable content once for dedup.
    let existing = new Set<string>();
    try {
      existing = new Set(listWorkspaceMemoryRecords(opts.workspacePath).map((r) => normalize(r.content)));
    } catch { /* best-effort */ }

    for (const [key, value] of entries) {
      if (result.promoted >= cfg.maxConsolidatedPerSession) break;
      const content = (value ?? "").trim();

      if (content.length < cfg.minConsolidatedFactChars || content.length > MAX_FACT_CHARS) { result.skipped++; continue; }
      if (TRANSIENT_KEY_RE.test(key)) { result.skipped++; continue; }
      if (SECRET_KEY_RE.test(key)) { result.skipped++; continue; }
      if (CREDENTIAL_RE.test(content)) { result.skipped++; continue; }

      const norm = normalize(content);
      // Exact or containment dedup against existing durable memory.
      let duplicate = existing.has(norm);
      if (!duplicate) {
        for (const prior of existing) {
          if (prior.includes(norm) || norm.includes(prior)) { duplicate = true; break; }
        }
      }
      if (duplicate) { result.skipped++; continue; }

      try {
        storeWorkspaceMemoryRecord(opts.workspacePath, {
          key: `session_fact:${key}`,
          subject: key,
          content,
          kind: "fact",
          tags: ["consolidated", "session-derived", `source-session:${opts.sessionId.slice(0, 8)}`],
        }, { sessionId: opts.sessionId });
        existing.add(norm);
        result.promoted++;
      } catch (err) {
        log.debug({ err, key }, "Session fact promotion failed");
        result.skipped++;
      }
    }

    if (result.promoted > 0) {
      logAudit("session_memory_consolidated", {
        sessionId: opts.sessionId,
        channel: opts.channel,
        promoted: result.promoted,
        skipped: result.skipped,
        factsSeen: entries.length,
      }, { sessionId: opts.sessionId, severity: "info" });
      log.info({ sessionId: opts.sessionId, promoted: result.promoted, skipped: result.skipped }, "Consolidated session facts into durable memory");
    }
  } catch (err) {
    log.debug({ err, sessionId: opts.sessionId }, "Session memory consolidation skipped — non-critical");
  }
  return result;
}
