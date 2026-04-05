/**
 * QuestDB timeseries tools — Stage 9.
 *
 * Agents can write timestamped metrics and query time-series data.
 * Uses QuestDB's HTTP API with InfluxDB line protocol for ingestion
 * and SQL for queries.
 *
 * Typical use cases:
 *   - Track agent performance metrics over time
 *   - Log events with precise timestamps during research
 *   - Record research findings with a timeline (then query all at end)
 *   - Monitor tool call latency trends
 */

import { registerTool, type ToolResult } from "./registry.js";
import { isQuestDbAvailable, questWrite, questQuery, buildLine, escapeLineTag } from "../db/questdb.js";

const NOT_AVAILABLE: ToolResult = {
  success: false,
  output: "",
  error: "QuestDB is not available. Ensure QUESTDB_URL is set and the questdb service is running.",
};

// ── metric_write ──────────────────────────────────────────────────────────────

registerTool({
  name: "metric_write",
  description: "Write a timestamped measurement to QuestDB. Use for recording agent events, performance data, research findings with timestamps, or any time-series data. Multiple calls create a timeline you can query later.",
  parameters: {
    type: "object",
    properties: {
      measurement: {
        type: "string",
        description: "Table/series name (snake_case, e.g. 'agent_events', 'research_findings', 'tool_latency'). Created automatically on first write.",
      },
      tags: {
        type: "object",
        description: "Indexed string labels for filtering/grouping (e.g. {agent: 'researcher', session: 'abc123', topic: 'ai_news'}). Values must be strings.",
      },
      fields: {
        type: "object",
        description: "Data values to record. Strings, numbers, and booleans are supported (e.g. {duration_ms: 230, status: 'success', summary: 'found 5 articles'}).",
      },
    },
    required: ["measurement", "fields"],
  },
  async execute(args): Promise<ToolResult> {
    if (!isQuestDbAvailable()) return NOT_AVAILABLE;

    const measurement = String(args["measurement"] ?? "")
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 64);
    if (!measurement) return { success: false, output: "", error: "measurement is required" };

    const rawFields = typeof args["fields"] === "object" && args["fields"]
      ? args["fields"] as Record<string, unknown>
      : {};
    const rawTags = typeof args["tags"] === "object" && args["tags"]
      ? args["tags"] as Record<string, string>
      : {};

    if (Object.keys(rawFields).length === 0) {
      return { success: false, output: "", error: "At least one field is required" };
    }

    // Only allow string, number, boolean field values
    const fields: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(rawFields)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        fields[k] = v;
      } else if (v !== null && v !== undefined) {
        fields[k] = String(v).slice(0, 1000);
      }
    }

    // Sanitize tags
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawTags)) {
      if (typeof v === "string" || typeof v === "number") {
        tags[escapeLineTag(k)] = escapeLineTag(String(v)).slice(0, 256);
      }
    }

    try {
      const line = buildLine({ measurement, tags, fields });
      await questWrite(line);
      return {
        success: true,
        output: `Written to ${measurement}: ${Object.keys(fields).join(", ")}`,
      };
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── metric_query ──────────────────────────────────────────────────────────────

registerTool({
  name: "metric_query",
  description: "Query time-series data from QuestDB using SQL. QuestDB supports standard SQL with time-series extensions: SAMPLE BY (downsampling), LATEST ON (last value per key), and timestamp range filters. Use this to retrieve accumulated research findings, performance trends, or event histories.",
  parameters: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "SQL query. Examples:\n- SELECT * FROM research_findings WHERE session = 'abc' ORDER BY timestamp DESC LIMIT 100\n- SELECT avg(duration_ms) FROM agent_events SAMPLE BY 1h\n- SELECT topic, content FROM research_findings WHERE agent = 'researcher' ORDER BY timestamp LIMIT 500",
      },
    },
    required: ["sql"],
  },
  async execute(args): Promise<ToolResult> {
    if (!isQuestDbAvailable()) return NOT_AVAILABLE;

    const sql = String(args["sql"] ?? "").trim();
    if (!sql) return { success: false, output: "", error: "sql is required" };

    // Safety: only SELECT/SHOW/EXPLAIN
    const upper = sql.trimStart().toUpperCase();
    if (!upper.startsWith("SELECT") && !upper.startsWith("SHOW") && !upper.startsWith("EXPLAIN")) {
      return { success: false, output: "", error: "metric_query is read-only. Only SELECT, SHOW, and EXPLAIN are allowed." };
    }

    try {
      const rows = await questQuery(sql);
      if (rows.length === 0) return { success: true, output: "Query returned 0 rows." };
      return {
        success: true,
        output: `${rows.length} row(s):\n${JSON.stringify(rows, null, 2)}`,
      };
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── metric_list_tables ────────────────────────────────────────────────────────

registerTool({
  name: "metric_list_tables",
  description: "List all time-series tables in QuestDB. Shows table name, column count, and whether it has a designated timestamp column.",
  parameters: { type: "object", properties: {} },
  async execute(): Promise<ToolResult> {
    if (!isQuestDbAvailable()) return NOT_AVAILABLE;
    try {
      const rows = await questQuery("SHOW TABLES");
      if (rows.length === 0) return { success: true, output: "No tables found in QuestDB." };
      return {
        success: true,
        output: `${rows.length} table(s):\n${rows.map(r => `  ${r["table_name"] ?? r["name"] ?? JSON.stringify(r)}`).join("\n")}`,
      };
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
});
