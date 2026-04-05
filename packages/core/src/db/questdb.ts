/**
 * QuestDB HTTP client singleton.
 *
 * QuestDB exposes two HTTP endpoints we use:
 *   POST /write  — InfluxDB line-protocol ingestion (metrics, events)
 *   GET  /exec   — SQL query API, returns JSON
 *
 * No npm driver needed — plain fetch over HTTP.
 * Used by tools/timeseries.ts.
 */
import { childLogger } from "../logger.js";

const log = childLogger("db:questdb");

function baseUrl(): string {
  return (process.env["QUESTDB_URL"] ?? "").replace(/\/$/, "");
}

export function isQuestDbAvailable(): boolean {
  return Boolean(process.env["QUESTDB_URL"]);
}

/**
 * Write one or more InfluxDB line-protocol measurements.
 *
 * Line protocol format:
 *   <measurement>[,<tag_key>=<tag_val>...] <field_key>=<field_val>[,<field_key>=<field_val>...] [<unix_ns_timestamp>]
 *
 * Example:
 *   "agent_events,agent=researcher event_type=\"search\",duration_ms=230i"
 */
export async function questWrite(lines: string | string[]): Promise<void> {
  const url = baseUrl();
  if (!url) return;

  const body = Array.isArray(lines) ? lines.join("\n") : lines;
  try {
    const res = await fetch(`${url}/write`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`QuestDB write failed ${res.status}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    log.warn({ err }, "QuestDB write failed");
    throw err;
  }
}

/**
 * Execute a SQL query and return rows as plain objects.
 * QuestDB SQL is largely standard SQL with time-series extensions.
 *
 * Returns empty array if QuestDB is unavailable.
 */
export async function questQuery(sql: string): Promise<Record<string, unknown>[]> {
  const url = baseUrl();
  if (!url) return [];

  try {
    const res = await fetch(`${url}/exec?${new URLSearchParams({ query: sql, limit: "1000" })}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`QuestDB query failed ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json() as { columns?: Array<{ name: string }>; dataset?: unknown[][] };

    // QuestDB returns { columns: [{name, type}], dataset: [[val, ...], ...] }
    const columns = json.columns ?? [];
    const rows = json.dataset ?? [];
    return rows.map(row =>
      Object.fromEntries(columns.map((col, i) => [col.name, row[i]]))
    );
  } catch (err) {
    log.warn({ err, sql: sql.slice(0, 200) }, "QuestDB query failed");
    throw err;
  }
}

/**
 * Escape a string value for InfluxDB line protocol (field values must be quoted).
 * Escapes backslashes and double-quotes.
 */
export function escapeLineValue(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Escape a tag value for InfluxDB line protocol (no spaces, commas, equals).
 */
export function escapeLineTag(s: string): string {
  return s.replace(/[ ,=]/g, "_");
}

/**
 * Build a single InfluxDB line-protocol line from structured input.
 */
export function buildLine(opts: {
  measurement: string;
  tags?: Record<string, string>;
  fields: Record<string, string | number | boolean>;
  timestampNs?: bigint;
}): string {
  const tagStr = opts.tags && Object.keys(opts.tags).length > 0
    ? "," + Object.entries(opts.tags)
      .map(([k, v]) => `${escapeLineTag(k)}=${escapeLineTag(v)}`)
      .join(",")
    : "";

  const fieldStr = Object.entries(opts.fields)
    .map(([k, v]) => {
      if (typeof v === "string") return `${k}=${escapeLineValue(v)}`;
      if (typeof v === "boolean") return `${k}=${v ? "true" : "false"}`;
      // integers must be suffixed with 'i' in line protocol
      if (Number.isInteger(v)) return `${k}=${v}i`;
      return `${k}=${v}`;
    })
    .join(",");

  const ts = opts.timestampNs !== undefined ? ` ${opts.timestampNs}` : "";
  return `${opts.measurement}${tagStr} ${fieldStr}${ts}`;
}
