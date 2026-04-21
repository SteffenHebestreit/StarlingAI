/**
 * Tier 2 (execute, per-call approval) — Run SQL queries against PostgreSQL or MySQL/MariaDB.
 *
 * Connection strings are resolved server-side from a named alias and NEVER accepted
 * inline from the LLM — this preserves the README guarantee that secrets cannot
 * enter model context. Resolution order for an alias `foo`:
 *   1. Encrypted credential store key `db:foo:url`
 *   2. Environment variable `SAI_DB_FOO_URL`
 *
 * All queries are parameterised and results are capped to prevent runaway data transfer.
 *
 * SQLite is intentionally not supported here to avoid native-module dependencies in the
 * container image. Use the filesystem + a shell tool for SQLite analysis.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { getCredential } from "../credentials/store.js";

const log = childLogger("tool:sql");

/** Cap rows returned to the agent. */
const MAX_ROWS = 500;
/** Safety limit — connection attempt timeout in ms. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Rough character cap for the serialised output sent back. */
const MAX_OUTPUT_CHARS = 48_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

/** Aliases must be short identifiers — no scheme, no userinfo, no symbols. */
const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Resolve a connection string from an alias.
 *
 * Hard rule (README credential safety): we NEVER accept an inline URL from the LLM.
 * Even if the LLM passes one, we refuse — the URL would be a credential the model
 * already exfiltrated into its own context.
 *
 * Returns the resolved connection string, or an error string explaining why
 * resolution failed.
 */
function resolveConnectionString(input: string): { url: string } | { error: string } {
  const trimmed = input.trim();

  if (!trimmed) return { error: "connection alias is required" };

  // Reject anything that looks like an inline URL — the LLM must never carry these.
  if (/:\/\//.test(trimmed) || trimmed.includes("@") || /\s/.test(trimmed)) {
    return {
      error:
        "Inline connection strings are not allowed. " +
        "Pass an alias (e.g. 'analytics') and configure its URL server-side via the credential store " +
        "(key 'db:<alias>:url') or the SAI_DB_<ALIAS>_URL env var.",
    };
  }

  if (!ALIAS_PATTERN.test(trimmed)) {
    return {
      error:
        "Invalid alias. Use a short identifier matching [A-Za-z][A-Za-z0-9_-]{0,63} " +
        "(letters, digits, underscore, hyphen).",
    };
  }

  // 1. Prefer the encrypted credential store
  const credKey = `db:${trimmed.toLowerCase()}:url`;
  const fromStore = getCredential(credKey);
  if (fromStore && fromStore.trim()) return { url: fromStore.trim() };

  // 2. Fall back to env var
  const envKey = `SAI_DB_${trimmed.toUpperCase().replace(/-/g, "_")}_URL`;
  const fromEnv = process.env[envKey];
  if (fromEnv && fromEnv.trim()) return { url: fromEnv.trim() };

  return {
    error:
      `No connection configured for alias '${trimmed}'. ` +
      `Add it via the credential store (key '${credKey}') or set ${envKey}.`,
  };
}

function detectDialect(connectionString: string): "postgres" | "mysql" | null {
  if (/^postgres(ql)?:\/\//i.test(connectionString)) return "postgres";
  if (/^mysql:\/\//i.test(connectionString)) return "mysql";
  if (/^mariadb:\/\//i.test(connectionString)) return "mysql";
  return null;
}

/** Serialise result rows to a compact table string for the agent. */
function rowsToText(
  columns: string[],
  rows: Record<string, unknown>[],
  totalFromDb: number,
  capped: boolean,
): string {
  if (rows.length === 0) return "(no rows returned)";

  const header = columns.join("\t");
  const divider = columns.map((c) => "-".repeat(Math.max(c.length, 4))).join("\t");
  const body = rows.map((row) =>
    columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return "NULL";
      if (val instanceof Date) return val.toISOString();
      if (typeof val === "object") return JSON.stringify(val);
      return String(val);
    }).join("\t")
  );

  const lines = [header, divider, ...body].join("\n");
  const cappedNote = capped
    ? `\n\n[Result capped at ${MAX_ROWS} rows. Total rows from database: ${totalFromDb}.]`
    : "";
  return lines + cappedNote;
}

// ─── PostgreSQL executor ────────────────────────────────────────────────────

async function runPostgres(
  connectionString: string,
  sql: string,
  params: unknown[],
  maxRows: number,
): Promise<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number; durationMs: number }> {
  const { default: pg } = await import("pg");
  const { Pool } = pg;

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 5_000,
  });

  try {
    const t0 = Date.now();
    const result = await pool.query({
      text: sql,
      values: params,
      rowMode: "array",
    });
    const durationMs = Date.now() - t0;

    const columns: string[] = result.fields.map((f) => f.name);
    const rawRows: unknown[][] = (result.rows as unknown[][]);
    const slicedRows = rawRows.slice(0, maxRows);
    const rows: Record<string, unknown>[] = slicedRows.map((row) => {
      const record: Record<string, unknown> = {};
      columns.forEach((col, i) => { record[col] = row[i]; });
      return record;
    });

    return { columns, rows, rowCount: rawRows.length, durationMs };
  } finally {
    await pool.end();
  }
}

// ─── MySQL executor ─────────────────────────────────────────────────────────

async function runMysql(
  connectionString: string,
  sql: string,
  params: unknown[],
  maxRows: number,
): Promise<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number; durationMs: number }> {
  const mysql2 = await import("mysql2/promise");

  // mysql2 only understands the mysql:// scheme — normalise mariadb:// before connecting.
  const normalisedUri = connectionString.replace(/^mariadb:\/\//i, "mysql://");

  const conn = await mysql2.createConnection({
    uri: normalisedUri,
    connectTimeout: CONNECT_TIMEOUT_MS,
    multipleStatements: false,
  });

  try {
    const t0 = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [rawRows, rawFields] = await conn.execute(sql, params as any);
    const durationMs = Date.now() - t0;

    const fieldsMeta = rawFields as Array<{ name: string }>;
    const columns = fieldsMeta.map((f) => f.name);
    const allRows = rawRows as Record<string, unknown>[];
    const slicedRows = allRows.slice(0, maxRows);

    return { columns, rows: slicedRows, rowCount: allRows.length, durationMs };
  } finally {
    await conn.end();
  }
}

// ─── Tool registration ───────────────────────────────────────────────────────

registerTool({
  name: "sql_query",
  description:
    "Execute a SQL query against a PostgreSQL or MySQL/MariaDB database and return the results. " +
    "Connections are resolved server-side from a named alias — inline connection strings are rejected " +
    "to keep database credentials out of model context. The alias maps to the encrypted credential " +
    "store key 'db:<alias>:url' or, as a fallback, the SAI_DB_<ALIAS>_URL env var. " +
    "All parameters must be passed separately via the params array to prevent SQL injection. " +
    "Results are capped at 500 rows. " +
    "Requires per-call approval because it executes statements against live databases.",
  embeddingDescription: "Run, execute a SQL query against a PostgreSQL or MySQL database. SQL-Abfrage ausführen, Datenbankabfrage, SELECT, INSERT, UPDATE, DELETE. Query database, Datenbank abfragen, Daten aus DB holen.",
  parameters: {
    type: "object",
    properties: {
      connection: {
        type: "string",
        description:
          "Named connection alias (e.g. 'analytics'). Must match [A-Za-z][A-Za-z0-9_-]{0,63}. " +
          "Inline URLs are rejected — configure the alias server-side via the credential store " +
          "(key 'db:<alias>:url') or the SAI_DB_<ALIAS>_URL environment variable.",
      },
      sql: {
        type: "string",
        description:
          "SQL statement to execute. Use positional placeholders ($1, $2 for Postgres; ? for MySQL). " +
          "Do NOT interpolate values directly into the SQL string — use params instead.",
      },
      params: {
        type: "array",
        items: {},
        description: "Ordered list of parameter values matching the placeholders in sql.",
        default: [],
      },
      max_rows: {
        type: "number",
        description: `Maximum rows to return (1–${MAX_ROWS}, default ${MAX_ROWS}).`,
        default: MAX_ROWS,
      },
    },
    required: ["connection", "sql"],
  },

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const rawConnection = String(args["connection"] ?? "").trim();
    const sqlText = String(args["sql"] ?? "").trim();
    const params = Array.isArray(args["params"]) ? args["params"] : [];
    const maxRows = Math.min(Math.max(Number(args["max_rows"] ?? MAX_ROWS), 1), MAX_ROWS);

    if (!rawConnection) return fail("connection is required");
    if (!sqlText) return fail("sql is required");

    const resolved = resolveConnectionString(rawConnection);
    if ("error" in resolved) {
      return fail(resolved.error);
    }
    const connectionString = resolved.url;

    const dialect = detectDialect(connectionString);
    if (!dialect) {
      return fail("Unsupported dialect. Connection string must start with postgresql://, postgres://, mysql://, or mariadb://");
    }

    log.info({ dialect, sessionId: _ctx.sessionId }, "sql_query executing");

    try {
      let result: { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; durationMs: number };

      if (dialect === "postgres") {
        result = await runPostgres(connectionString, sqlText, params, maxRows);
      } else {
        result = await runMysql(connectionString, sqlText, params, maxRows);
      }

      const capped = result.rowCount > maxRows;
      const slicedRows = result.rows.slice(0, maxRows);
      const tableText = rowsToText(result.columns, slicedRows, result.rowCount, capped);

      let output = tableText;
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + `\n\n[Output truncated at ${MAX_OUTPUT_CHARS} chars]`;
      }

      return {
        success: true,
        output,
        metadata: {
          dialect,
          columns: result.columns,
          rowCount: result.rowCount,
          rowsReturned: slicedRows.length,
          capped,
          durationMs: result.durationMs,
        },
      };
    } catch (err) {
      log.error({ err, dialect }, "sql_query failed");
      // Drivers sometimes embed the connection URL (with credentials) in error messages — strip it.
      const sanitised = String(err).replace(/(postgres(?:ql)?|mysql|mariadb):\/\/[^\s'"]+/gi, "$1://[redacted]");
      return fail(`SQL query failed: ${sanitised}`);
    }
  },
});
