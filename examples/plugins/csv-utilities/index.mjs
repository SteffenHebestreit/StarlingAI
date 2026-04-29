/**
 * Example plugin: csv-utilities
 *
 * Drop this directory into ~/.starlingai/plugins/ (or whichever path your
 * `plugins.dir` config points at) and the gateway will auto-load it on
 * startup or hot-reload it via the file watcher.
 *
 * Tools register at:
 *   plugin__csv-utilities__parse_csv
 *   plugin__csv-utilities__csv_summary
 *
 * All plugin tools run at Tier 2 (sandboxed, per-call approval).  See
 * packages/core/src/plugin/README.md in the StarlingAI repo for the
 * author guide.
 */

function parseCsvText(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const headers = splitRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitRow(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ""; });
    rows.push(row);
  }
  return rows;
}

function splitRow(line) {
  // Minimal CSV split — handles quoted commas but not multi-line cells.
  const out = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") { inQuote = !inQuote; continue; }
    if (ch === "," && !inQuote) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

export default {
  name: "csv-utilities",
  version: "1.0.0",
  description: "Parse, summarize, and inspect CSV data without spawning a sub-agent.",
  author: "StarlingAI examples",
  tools: [
    {
      name: "parse_csv",
      description: "Parse a CSV string into an array of JSON row objects keyed by the header row.",
      embeddingDescription: "convert csv to json; parse comma-separated values; csv reader; tabular data",
      costHint: "low",
      latencyHint: "low",
      parameters: {
        type: "object",
        properties: {
          csv: { type: "string", description: "Raw CSV text." },
        },
        required: ["csv"],
      },
      async execute(args) {
        const rows = parseCsvText(String(args.csv ?? ""));
        return {
          success: true,
          output: JSON.stringify(rows),
          metadata: { rowCount: rows.length },
        };
      },
    },
    {
      name: "csv_summary",
      description: "Summarize a CSV: row count, column names, and a per-column non-empty cell count. Useful for quick data quality checks before deeper analysis.",
      embeddingDescription: "csv overview; describe csv; column inventory; data quality check",
      costHint: "low",
      latencyHint: "low",
      parameters: {
        type: "object",
        properties: {
          csv: { type: "string", description: "Raw CSV text." },
        },
        required: ["csv"],
      },
      async execute(args) {
        const rows = parseCsvText(String(args.csv ?? ""));
        if (rows.length === 0) {
          return { success: true, output: "Empty CSV — no rows parsed.", metadata: { rowCount: 0 } };
        }
        const columns = Object.keys(rows[0]);
        const counts = Object.fromEntries(
          columns.map((c) => [c, rows.filter((r) => String(r[c] ?? "").length > 0).length]),
        );
        const lines = [
          `Rows: ${rows.length}`,
          `Columns (${columns.length}): ${columns.join(", ")}`,
          "",
          "Non-empty cells per column:",
          ...columns.map((c) => `  - ${c}: ${counts[c]}/${rows.length}`),
        ];
        return {
          success: true,
          output: lines.join("\n"),
          metadata: { rowCount: rows.length, columnCount: columns.length, nonEmptyCounts: counts },
        };
      },
    },
  ],
};
