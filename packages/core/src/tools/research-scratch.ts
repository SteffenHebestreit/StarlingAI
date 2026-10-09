/**
 * Research scratchpad tools — context-safe deep research storage.
 *
 * Problem: During deep research, accumulating findings in the conversation
 * context causes context overflow. The researcher writes many intermediate
 * results that only the writer agent needs at the end.
 *
 * Solution: Write findings to QuestDB (timeseries) or the ephemeral store
 * as they are discovered. The writer agent reads them all at once only
 * when composing the final output.
 *
 * Workflow:
 *   1. researcher calls research_note() for each finding (no context growth)
 *   2. After all research is done, writer calls research_notes_read() to get
 *      all findings in one structured response
 *   3. Optionally call research_notes_clear() to clean up
 *
 * Notes are scoped by the turn's SHARED session id + topic (see scratchSessionId).
 * Uses QuestDB when available, falls back to the ephemeral store (Redis); reads
 * always merge both, since a note lands in whichever store took the write.
 */

import { v4 as uuid } from "uuid";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { isQuestDbAvailable, questWrite, questQuery, buildLine, escapeLineTag, escapeSqlString } from "../db/questdb.js";
import { ephemeralPut as _ephemeralPut, ephemeralQuery as _ephemeralQuery, ephemeralDelete as _ephemeralDelete } from "../runtime/ephemeral-store/index.js";
import { deriveSharedSessionId } from "./memory.js";

const RESEARCH_NAMESPACE = "research-notes";
const MAX_NOTE_LENGTH = 4000;
const MAX_NOTES_RETURNED = 500;
/** Ephemeral entries a read scans before filtering: the store returns its NEWEST n, so a small
 *  n with a topic or importance filter applied afterwards silently dropped older matches. */
const EPHEMERAL_SCAN_LIMIT = 2000;
const IMPORTANCE_LEVELS = { low: 0, medium: 1, high: 2 } as const;
type Importance = keyof typeof IMPORTANCE_LEVELS;

/**
 * The scratchpad belongs to the user-facing turn, not to the agent writing it. Notes were keyed
 * by ctx.sessionId, and a sub-agent's id is `sub:<parent>:<agent>:<ts>` — so the researcher wrote
 * under its own id and the writer, reading under ITS own id, found "No research notes": the
 * hand-off this scratchpad exists for never happened. Shared facts solved the same problem with
 * deriveSharedSessionId; the scratchpad uses the same bucket.
 */
function scratchSessionId(ctx: ToolContext): string {
  return deriveSharedSessionId(ctx.sessionId);
}

/** The session as stored in the QuestDB tag — written and queried in the same escaped form. */
function scratchSessionTag(ctx: ToolContext): string {
  return escapeLineTag(scratchSessionId(ctx).slice(0, 64));
}

/** A topic as stored: trimmed, capped and line-protocol-escaped. Writes and every read filter go
 *  through this, so "key findings" finds the notes stored as "key_findings" in both stores. */
function normalizeTopic(raw: unknown): string {
  return escapeLineTag(String(raw ?? "general").trim().slice(0, 128));
}

function parseImportance(raw: unknown): Importance | undefined {
  return typeof raw === "string" && raw in IMPORTANCE_LEVELS ? raw as Importance : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The run that wrote a note: its own session id, unique per run (`sub:<root>:<agent>:<ts>` for a
 *  sub-agent) — so two parallel slices of the same agent are still two writers. */
function noteWriter(ctx: ToolContext): string {
  return ctx.sessionId;
}

/**
 * When the current turn began, if the context says. The orchestrator's context carries
 * turnStartedAt; a sub-agent's carries the turn's swarmState, created fresh each turn. Notes are
 * keyed by the chat's root session, so without this a read in turn 5 returned turn 1's notes first.
 */
function turnStartMs(ctx: ToolContext): number | undefined {
  if (typeof ctx.turnStartedAt === "number" && Number.isFinite(ctx.turnStartedAt)) return ctx.turnStartedAt;
  const fromSwarm = Date.parse(ctx.swarmState?.startedAt ?? "");
  return Number.isFinite(fromSwarm) ? fromSwarm : undefined;
}

// ── research_note ─────────────────────────────────────────────────────────────

registerTool({
  name: "research_note",
  description: "Save a research finding to the scratchpad without adding it to the conversation context. Call this repeatedly during deep research to accumulate findings — the context stays small. Use research_notes_read at the end to retrieve everything for writing the final output.",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Topic or category for this note (e.g. 'background', 'findings', 'statistics', 'quotes', 'sources'). Used to group related notes.",
      },
      content: {
        type: "string",
        description: "The research finding, fact, quote, or data to save. Markdown is supported.",
      },
      source: {
        type: "string",
        description: "Optional source URL, document name, or citation for this finding.",
      },
      importance: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Importance level — used to prioritize when reading notes later (default: medium).",
      },
    },
    required: ["topic", "content"],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const topic = normalizeTopic(args["topic"]);
    const content = String(args["content"] ?? "").trim().slice(0, MAX_NOTE_LENGTH);
    const source = args["source"] ? String(args["source"]).trim().slice(0, 500) : "";
    const importance = parseImportance(args["importance"]) ?? "medium";
    const sessionId = scratchSessionId(ctx);

    if (!content) return { success: false, output: "", error: "content is required" };

    if (isQuestDbAvailable()) {
      try {
        const line = buildLine({
          measurement: "research_notes",
          tags: {
            session: scratchSessionTag(ctx),
            topic,
            importance,
            writer: escapeLineTag(noteWriter(ctx).slice(0, 160)),
          },
          fields: {
            content,
            ...(source ? { source } : {}),
          },
        });
        await questWrite(line);
        return { success: true, output: `Note saved [${topic}/${importance}]. Use research_notes_read to retrieve all notes.` };
      } catch {
        // fall through to ephemeral store
      }
    }

    // Fallback: ephemeral store (research-notes namespace → Redis)
    const noteId = uuid();
    const key = `${sessionId}:${topic}:${noteId}`;
    await _ephemeralPut({
      namespace: RESEARCH_NAMESPACE,
      key,
      value: JSON.stringify({ topic, content, source, importance, ts: new Date().toISOString(), writer: noteWriter(ctx) }),
      sessionId,
      agentName: ctx.currentAgentName,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    return { success: true, output: `Note saved [${topic}/${importance}]. Use research_notes_read to retrieve all notes.` };
  },
});

// ── research_notes_read ───────────────────────────────────────────────────────

registerTool({
  name: "research_notes_read",
  description: "Read the research notes every agent of this turn saved. Call this once at the end of research to retrieve all findings before writing the final output. Notes are returned grouped by topic and sorted by time; the answer says which turn and which stores they came from.",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Optional: filter to a specific topic only.",
      },
      importance: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Optional: only return notes at this importance level or higher.",
      },
      limit: {
        type: "number",
        description: `Max notes to return, newest kept (default: ${MAX_NOTES_RETURNED})`,
      },
      all_turns: {
        type: "boolean",
        description: "Include notes saved in earlier turns of this chat (default: this turn's notes when it has any).",
      },
    },
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const filterTopic = args["topic"] ? normalizeTopic(args["topic"]) : undefined;
    const filterImportance = parseImportance(args["importance"]);
    const limit = Math.max(1, Math.min(MAX_NOTES_RETURNED, typeof args["limit"] === "number" ? Math.floor(args["limit"]) : MAX_NOTES_RETURNED));
    // Importance is a filter on WHICH notes count, so it runs before the limit — applied after
    // it, a limit of 20 over 20 low notes and one high one answered "no high notes".
    const allowedImportance = filterImportance
      ? (Object.keys(IMPORTANCE_LEVELS) as Importance[]).filter((level) => IMPORTANCE_LEVELS[level] >= IMPORTANCE_LEVELS[filterImportance])
      : null;
    const passesImportance = (importance: string): boolean =>
      !allowedImportance || allowedImportance.includes((parseImportance(importance) ?? "medium"));

    interface NoteRow { topic: string; content: string; source?: string; importance: string; ts?: string }
    const pool: NoteRow[] = [];
    /** One line per store: what was searched and what it held, or why it could not be read. */
    const searched: string[] = [];
    /** Lines saying what the stores hold that this read did not load. */
    const unread: string[] = [];
    let storeFailed = false;
    /** QuestDB notes past the newest MAX_NOTES_RETURNED: counted, not loaded. */
    let questUnread = 0;

    // Both stores, always. A note lands in QuestDB when its write succeeded there and in the
    // ephemeral store otherwise, so one read can hold notes from each. The ephemeral store used to
    // be read only when QuestDB returned NOTHING: one QuestDB row hid every ephemeral note.
    // Newest first in both, so a cap drops the OLDEST notes: notes pile up over every turn of a
    // chat, and `ORDER BY timestamp ASC LIMIT 500` silently dropped the newest ones once past 500.
    if (isQuestDbAvailable()) {
      try {
        const topicFilter = filterTopic ? ` AND topic = '${escapeSqlString(filterTopic)}'` : "";
        const importanceFilter = allowedImportance ? ` AND importance IN (${allowedImportance.map((level) => `'${level}'`).join(", ")})` : "";
        const where = `WHERE session = '${escapeSqlString(scratchSessionTag(ctx))}'${topicFilter}${importanceFilter}`;
        const [rows, countRows] = await Promise.all([
          questQuery(`SELECT topic, content, source, importance, timestamp AS ts FROM research_notes ${where} ORDER BY timestamp DESC LIMIT ${MAX_NOTES_RETURNED}`),
          questQuery(`SELECT count() AS n FROM research_notes ${where}`),
        ]);
        const questNotes = (rows as unknown as NoteRow[]).filter((n) => passesImportance(n.importance));
        const questTotal = Number(countRows[0]?.["n"]);
        pool.push(...questNotes);
        searched.push(`QuestDB (${questNotes.length})`);
        if (Number.isFinite(questTotal) && questTotal > questNotes.length) {
          questUnread = questTotal - questNotes.length;
          unread.push(`QuestDB holds ${questTotal} matching notes; only the newest ${questNotes.length} were read.`);
        }
      } catch (err) {
        storeFailed = true;
        searched.push(`QuestDB FAILED (${errorMessage(err)}) — notes stored there are missing from this answer`);
      }
    }

    const entries = await _ephemeralQuery({ namespace: RESEARCH_NAMESPACE, sessionId: scratchSessionId(ctx), limit: EPHEMERAL_SCAN_LIMIT });
    const ephemeralNotes = entries
      .map((e): NoteRow => {
        try { return JSON.parse(e.value) as NoteRow; }
        catch { return { topic: "unknown", content: e.value, importance: "medium" }; }
      })
      .filter((n) => (!filterTopic || n.topic === filterTopic) && passesImportance(n.importance));
    searched.push(`ephemeral store (${ephemeralNotes.length})`);
    if (entries.length >= EPHEMERAL_SCAN_LIMIT) {
      unread.push(`The ephemeral store was read up to its newest ${EPHEMERAL_SCAN_LIMIT} notes; older ones were not.`);
    }
    const seen = new Set(pool.map((n) => `${n.topic}\u0000${n.content}\u0000${n.source ?? ""}`));
    for (const note of ephemeralNotes) {
      const key = `${note.topic}\u0000${note.content}\u0000${note.source ?? ""}`;
      if (!seen.has(key)) { seen.add(key); pool.push(note); }
    }

    // This turn's notes when it has any: the scratchpad is keyed by the chat, so without this a
    // writer in turn 5 got turn 1's findings mixed in. A turn with none falls back to the chat's
    // notes and says so; all_turns asks for everything.
    const time = (ts: string | undefined): number => { const t = Date.parse(ts ?? ""); return Number.isFinite(t) ? t : 0; };
    const turnStart = turnStartMs(ctx);
    const allTurns = args["all_turns"] === true;
    const thisTurn = turnStart === undefined ? pool : pool.filter((n) => time(n.ts) >= turnStart);
    let scopeLine: string;
    let candidates: NoteRow[];
    if (allTurns || turnStart === undefined) {
      candidates = pool;
      scopeLine = allTurns ? "Notes from every turn of this chat." : "Notes from this chat (the current turn could not be told apart).";
    } else if (thisTurn.length > 0) {
      candidates = thisTurn;
      const earlier = pool.length - thisTurn.length;
      scopeLine = `Notes from this turn${earlier > 0 ? `; ${earlier} note(s) from earlier turns of this chat not shown — pass all_turns: true to include them` : ""}.`;
    } else {
      candidates = pool;
      scopeLine = "No notes were saved in this turn; these are from earlier turns of this chat.";
    }
    // Keep the newest `limit`, then show them in the order they were written.
    const notes = [...candidates].sort((a, b) => time(b.ts) - time(a.ts)).slice(0, limit).reverse();
    // The count includes QuestDB notes past the read cap when the whole chat is in scope (they are
    // older than everything read, so they belong to earlier turns).
    const matching = candidates.length + (candidates === pool ? questUnread : 0);
    const searchedLine = `Searched: ${searched.join(", ")}.`;

    if (notes.length === 0) {
      if (storeFailed) {
        return { success: false, output: "", error: `No research notes could be read. ${searchedLine} This is not evidence that none were saved.` };
      }
      return { success: true, output: `No research notes found for this session. ${[searchedLine, ...unread].join(" ")}` };
    }

    // Group by topic
    const byTopic = new Map<string, NoteRow[]>();
    for (const note of notes) {
      const t = note.topic ?? "general";
      if (!byTopic.has(t)) byTopic.set(t, []);
      byTopic.get(t)!.push(note);
    }

    const sections: string[] = [`## Research Notes (${notes.length} total)\n`];
    for (const [topic, topicNotes] of byTopic) {
      sections.push(`### ${topic} (${topicNotes.length})`);
      for (const note of topicNotes) {
        const badge = note.importance === "high" ? " ⭐" : note.importance === "low" ? " (low)" : "";
        sections.push(`${note.content}${badge}${note.source ? `\n*Source: ${note.source}*` : ""}`);
        sections.push("---");
      }
    }
    if (matching > notes.length) {
      sections.push(`Showing the newest ${notes.length} of ${matching} matching notes — raise limit (max ${MAX_NOTES_RETURNED}) or filter by topic to see the rest.`);
    }
    sections.push(scopeLine, searchedLine, ...unread);

    return { success: true, output: sections.join("\n"), metadata: { returned: notes.length, matching, stores: searched } };
  },
});

// ── research_notes_summary ────────────────────────────────────────────────────

registerTool({
  name: "research_notes_summary",
  description: "Get a count summary of research notes by topic and importance — without returning the full content. Use this to check what has been accumulated before deciding whether to read everything.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx: ToolContext): Promise<ToolResult> {
    // Counted across BOTH stores, as research_notes_read reads them.
    const counts = new Map<string, number>();
    const add = (topic: string, importance: string, n: number): void => {
      const key = `${topic} [${parseImportance(importance) ?? "medium"}]`;
      counts.set(key, (counts.get(key) ?? 0) + n);
    };
    const searched: string[] = [];
    let storeFailed = false;
    if (isQuestDbAvailable()) {
      try {
        const rows = await questQuery(
          `SELECT topic, importance, count() AS n
           FROM research_notes
           WHERE session = '${escapeSqlString(scratchSessionTag(ctx))}'
           GROUP BY topic, importance
           ORDER BY topic, importance`
        );
        let total = 0;
        for (const r of rows) { const n = Number(r["n"]) || 0; total += n; add(String(r["topic"]), String(r["importance"]), n); }
        searched.push(`QuestDB (${total})`);
      } catch (err) {
        storeFailed = true;
        searched.push(`QuestDB FAILED (${errorMessage(err)}) — its notes are not counted`);
      }
    }

    const entries = await _ephemeralQuery({ namespace: RESEARCH_NAMESPACE, sessionId: scratchSessionId(ctx), limit: EPHEMERAL_SCAN_LIMIT });
    for (const e of entries) {
      try {
        const { topic, importance } = JSON.parse(e.value) as { topic: string; importance: string };
        add(topic, importance, 1);
      } catch { add("unknown", "medium", 1); }
    }
    searched.push(`ephemeral store (${entries.length})`);
    const searchedLine = `Searched: ${searched.join(", ")}.`;

    if (counts.size === 0) {
      return storeFailed
        ? { success: false, output: "", error: `Research notes could not be counted. ${searchedLine}` }
        : { success: true, output: `No research notes yet. ${searchedLine}` };
    }
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const lines = [...counts.entries()].map(([key, n]) => `  ${key}: ${n} note(s)`);
    return { success: true, output: `Research notes summary (${total} total):\n${lines.join("\n")}\n${searchedLine}` };
  },
});

// ── research_notes_clear ──────────────────────────────────────────────────────

registerTool({
  name: "research_notes_clear",
  description: "Clear research notes. By default only the notes THIS agent saved; pass all_agents: true to clear every agent's notes in this chat — only once no other agent still needs them. Call after the final output has been written.",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Optional: only clear notes for this topic. Omit to clear all of them.",
      },
      all_agents: {
        type: "boolean",
        description: "Also clear notes other agents saved (a parallel researcher's, for one). Default false.",
      },
    },
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const filterTopic = args["topic"] ? normalizeTopic(args["topic"]) : undefined;
    const allAgents = args["all_agents"] === true;
    const writer = noteWriter(ctx);

    // Ephemeral store: query and delete matching entries. Notes are shared by every agent of the
    // chat, so a clear with no topic used to wipe a PARALLEL slice's notes before its writer read
    // them. Each note now records the run that wrote it, and a clear takes only the caller's own
    // unless asked for all (a note from before writers were recorded counts as someone else's).
    const entries = await _ephemeralQuery({ namespace: RESEARCH_NAMESPACE, sessionId: scratchSessionId(ctx), limit: EPHEMERAL_SCAN_LIMIT });
    let deleted = 0;
    let keptForOthers = 0;
    for (const e of entries) {
      let note: { topic?: string; writer?: string } = {};
      try { note = JSON.parse(e.value) as { topic?: string; writer?: string }; } catch { /* unparseable: matched by nothing but all_agents */ }
      if (filterTopic && note.topic !== filterTopic) continue;
      if (!allAgents && note.writer !== writer) { keptForOthers++; continue; }
      await _ephemeralDelete(RESEARCH_NAMESPACE, e.key);
      deleted++;
    }

    // QuestDB: rows age out naturally (no DELETE support in all versions), so notes stored there
    // are still returned by research_notes_read — say so rather than report a clean scratchpad.
    const questNote = isQuestDbAvailable()
      ? " Notes stored in QuestDB cannot be deleted and research_notes_read still returns them."
      : "";

    const kept = keptForOthers > 0
      ? ` Kept ${keptForOthers} note(s) other agents saved — pass all_agents: true to clear those too, once nothing still needs them.`
      : "";
    return {
      success: true,
      output: (deleted > 0 ? `Cleared ${deleted} note(s) from the ephemeral store.` : "No notes found to clear in the ephemeral store.") + kept + questNote,
      metadata: { deleted, keptForOthers },
    };
  },
});

