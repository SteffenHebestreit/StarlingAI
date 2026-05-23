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
 * Notes are scoped by sessionId + topic so parallel research threads don't mix.
 * Uses QuestDB when available, falls back to the ephemeral store (Redis).
 */

import { v4 as uuid } from "uuid";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { isQuestDbAvailable, questWrite, questQuery, buildLine, escapeLineTag, escapeSqlString } from "../db/questdb.js";
import { ephemeralPut as _ephemeralPut, ephemeralQuery as _ephemeralQuery, ephemeralDelete as _ephemeralDelete } from "../runtime/ephemeral-store/index.js";

const RESEARCH_NAMESPACE = "research-notes";
const MAX_NOTE_LENGTH = 4000;
const MAX_NOTES_RETURNED = 500;

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
    const topic = escapeLineTag(String(args["topic"] ?? "general").trim().slice(0, 128));
    const content = String(args["content"] ?? "").trim().slice(0, MAX_NOTE_LENGTH);
    const source = args["source"] ? String(args["source"]).trim().slice(0, 500) : "";
    const importance = (["low", "medium", "high"] as const).includes(args["importance"] as "low" | "medium" | "high")
      ? String(args["importance"]) as "low" | "medium" | "high"
      : "medium";

    if (!content) return { success: false, output: "", error: "content is required" };

    if (isQuestDbAvailable()) {
      try {
        const line = buildLine({
          measurement: "research_notes",
          tags: {
            session: escapeLineTag(ctx.sessionId.slice(0, 64)),
            topic,
            importance,
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
    const key = `${ctx.sessionId}:${topic}:${noteId}`;
    await _ephemeralPut({
      namespace: RESEARCH_NAMESPACE,
      key,
      value: JSON.stringify({ topic, content, source, importance, ts: new Date().toISOString() }),
      sessionId: ctx.sessionId,
      agentName: undefined,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    return { success: true, output: `Note saved [${topic}/${importance}]. Use research_notes_read to retrieve all notes.` };
  },
});

// ── research_notes_read ───────────────────────────────────────────────────────

registerTool({
  name: "research_notes_read",
  description: "Read all research notes accumulated during this session. Call this once at the end of research to retrieve all findings before writing the final output. Notes are returned grouped by topic and sorted by time.",
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
        description: `Max notes to return (default: ${MAX_NOTES_RETURNED})`,
      },
    },
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const filterTopic = args["topic"] ? String(args["topic"]).trim() : undefined;
    const filterImportance = (["low", "medium", "high"] as const).includes(args["importance"] as "low" | "medium" | "high")
      ? String(args["importance"])
      : undefined;
    const limit = Math.min(MAX_NOTES_RETURNED, typeof args["limit"] === "number" ? args["limit"] : MAX_NOTES_RETURNED);

    interface NoteRow { topic: string; content: string; source?: string; importance: string; ts?: string }
    let notes: NoteRow[] = [];

    if (isQuestDbAvailable()) {
      try {
        const sessionEsc = escapeSqlString(ctx.sessionId.slice(0, 64));
        const topicFilter = filterTopic ? ` AND topic = '${escapeSqlString(escapeLineTag(filterTopic))}'` : "";
        const rows = await questQuery(
          `SELECT topic, content, source, importance, timestamp AS ts
           FROM research_notes
           WHERE session = '${sessionEsc}'${topicFilter}
           ORDER BY timestamp ASC
           LIMIT ${limit}`
        );
        notes = rows as unknown as NoteRow[];
      } catch {
        // fall through to ephemeral store
      }
    }

    if (notes.length === 0) {
      // Fallback: ephemeral store
      const entries = await _ephemeralQuery({ namespace: RESEARCH_NAMESPACE, sessionId: ctx.sessionId, limit });
      notes = entries.map(e => {
        try { return JSON.parse(e.value) as NoteRow; }
        catch { return { topic: "unknown", content: e.value, importance: "medium" }; }
      });
      if (filterTopic) notes = notes.filter(n => n.topic === filterTopic);
      notes.sort((a, b) => (a.ts ?? "") < (b.ts ?? "") ? -1 : 1);
    }

    // Filter by importance
    if (filterImportance) {
      const levels = { low: 0, medium: 1, high: 2 };
      const minLevel = levels[filterImportance as keyof typeof levels] ?? 0;
      notes = notes.filter(n => (levels[n.importance as keyof typeof levels] ?? 1) >= minLevel);
    }

    if (notes.length === 0) {
      return { success: true, output: "No research notes found for this session." };
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

    return { success: true, output: sections.join("\n") };
  },
});

// ── research_notes_summary ────────────────────────────────────────────────────

registerTool({
  name: "research_notes_summary",
  description: "Get a count summary of research notes by topic and importance — without returning the full content. Use this to check what has been accumulated before deciding whether to read everything.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx: ToolContext): Promise<ToolResult> {
    if (isQuestDbAvailable()) {
      try {
        const sessionEsc = escapeSqlString(ctx.sessionId.slice(0, 64));
        const rows = await questQuery(
          `SELECT topic, importance, count() AS n
           FROM research_notes
           WHERE session = '${sessionEsc}'
           GROUP BY topic, importance
           ORDER BY topic, importance`
        );
        if (rows.length === 0) return { success: true, output: "No research notes yet." };
        const lines = rows.map(r => `  ${r["topic"]} [${r["importance"]}]: ${r["n"]} note(s)`);
        return { success: true, output: `Research notes summary:\n${lines.join("\n")}` };
      } catch {
        // fall through
      }
    }

    // Fallback
    const entries = await _ephemeralQuery({ namespace: RESEARCH_NAMESPACE, sessionId: ctx.sessionId, limit: 1000 });
    if (entries.length === 0) return { success: true, output: "No research notes yet." };

    const counts = new Map<string, number>();
    for (const e of entries) {
      try {
        const { topic } = JSON.parse(e.value) as { topic: string };
        counts.set(topic, (counts.get(topic) ?? 0) + 1);
      } catch { /* ignore */ }
    }
    const lines = [...counts.entries()].map(([t, n]) => `  ${t}: ${n} note(s)`);
    return { success: true, output: `Research notes summary (${entries.length} total):\n${lines.join("\n")}` };
  },
});

// ── research_notes_clear ──────────────────────────────────────────────────────

registerTool({
  name: "research_notes_clear",
  description: "Clear all research notes for this session. Call after the final output has been written and the notes are no longer needed.",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Optional: only clear notes for this topic. Omit to clear all notes for the session.",
      },
    },
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const filterTopic = args["topic"] ? String(args["topic"]).trim() : undefined;

    // Ephemeral store: query and delete matching entries
    const entries = await _ephemeralQuery({ namespace: RESEARCH_NAMESPACE, sessionId: ctx.sessionId, limit: 2000 });
    let deleted = 0;
    for (const e of entries) {
      if (filterTopic) {
        try {
          const { topic } = JSON.parse(e.value) as { topic: string };
          if (topic !== filterTopic) continue;
        } catch { /* delete anyway */ }
      }
      await _ephemeralDelete(RESEARCH_NAMESPACE, e.key);
      deleted++;
    }

    // QuestDB: rows age out naturally (no DELETE support in all versions)
    // We rely on session-scoped queries to ignore old data naturally.

    return { success: true, output: deleted > 0 ? `Cleared ${deleted} note(s) from scratchpad.` : "No notes found to clear." };
  },
});

