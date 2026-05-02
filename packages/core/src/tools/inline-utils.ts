/**
 * Tier 0 inline computation utilities — narrow, deterministic helpers that
 * agents kept either delegating to a sub-agent for or hand-rolling in the
 * LLM (often wrong).  Each tool below is small enough to live in-process
 * with no external dependencies.
 *
 *   datetime_arithmetic — add/subtract durations, compute deltas, format
 *   json_query          — jq-lite path extraction from a JSON value
 *   regex_test          — test a regex with capture groups + match offsets
 *
 * All three are read-only (Tier 0) and never need approval or sandboxing.
 */
import { registerTool, type ToolResult } from "./registry.js";

// ─── datetime_arithmetic ─────────────────────────────────────────────────────

const DURATION_PATTERN = /^([+-]?\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?|w|weeks?|mo|months?|y|years?)$/i;

interface DurationParts {
  ms: number;
  months: number;
  years: number;
}

/**
 * Parse a single duration token like "5m", "-3 days", "2 weeks".  Months
 * and years can't be expressed as a fixed ms count without knowing the
 * base date, so they're tracked separately and applied via Date setters.
 */
function parseDuration(input: string): DurationParts | null {
  const m = DURATION_PATTERN.exec(input.trim());
  if (!m) return null;
  const value = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  switch (unit) {
    case "ms": return { ms: value, months: 0, years: 0 };
    case "s": case "sec": case "second": case "seconds": return { ms: value * 1000, months: 0, years: 0 };
    case "m": case "min": case "minute": case "minutes": return { ms: value * 60_000, months: 0, years: 0 };
    case "h": case "hr": case "hour": case "hours": return { ms: value * 3_600_000, months: 0, years: 0 };
    case "d": case "day": case "days": return { ms: value * 86_400_000, months: 0, years: 0 };
    case "w": case "week": case "weeks": return { ms: value * 7 * 86_400_000, months: 0, years: 0 };
    case "mo": case "month": case "months": return { ms: 0, months: value, years: 0 };
    case "y": case "year": case "years": return { ms: 0, months: 0, years: value };
    default: return null;
  }
}

function applyDuration(base: Date, parts: DurationParts): Date {
  const out = new Date(base.getTime() + parts.ms);
  if (parts.months !== 0) out.setUTCMonth(out.getUTCMonth() + Math.trunc(parts.months));
  if (parts.years !== 0) out.setUTCFullYear(out.getUTCFullYear() + Math.trunc(parts.years));
  return out;
}

function parseDate(input: string): Date | null {
  if (!input || input.toLowerCase() === "now") return new Date();
  const ts = Date.parse(input);
  if (Number.isNaN(ts)) return null;
  return new Date(ts);
}

registerTool({
  name: "datetime_arithmetic",
  description:
    "Tier-0 date/time math.  Operations: 'add' (base + duration), 'subtract' (base - duration), 'diff' (between two dates as ms/seconds/minutes/hours/days), 'format' (parse + reformat). " +
    "Durations are expressed as 'N unit' tokens (ms, s, m, h, d, w, mo, y).  Negative values are accepted.  Months and years are calendar-aware (not fixed ms). " +
    "Use this instead of asking the model to compute dates in its head — the model is often wrong about leap years, month lengths, and timezone conversions.",
  embeddingDescription:
    "Compute dates and durations.  When is N days from now, how many days between two dates, parse a timestamp, format ISO date.  Datum berechnen, Tage zwischen zwei Daten, Zeitspanne, in Tagen umrechnen, ISO-Datum formatieren.  No timezone interpretation beyond the input — durations apply in UTC.",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["add", "subtract", "diff", "format"],
        description: "Which operation to perform.",
      },
      base: {
        type: "string",
        description: "Base date.  ISO 8601 string, or 'now'.  Required for add/subtract/format.  Used as the start date for diff.",
      },
      target: {
        type: "string",
        description: "Target date for diff.  ISO 8601 string or 'now'.  Required only when operation='diff'.",
      },
      duration: {
        type: "string",
        description: "Duration token like '5d', '90 minutes', '-2 weeks', '6 months'.  Required for add/subtract.",
      },
      unit: {
        type: "string",
        enum: ["ms", "seconds", "minutes", "hours", "days"],
        description: "Output unit for diff.  Defaults to 'days'.",
        default: "days",
      },
    },
    required: ["operation"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const op = String(args["operation"] ?? "");
    if (!["add", "subtract", "diff", "format"].includes(op)) {
      return { success: false, output: "", error: `Unknown operation '${op}'.  Use add, subtract, diff, or format.` };
    }

    if (op === "add" || op === "subtract" || op === "format") {
      const base = parseDate(String(args["base"] ?? ""));
      if (!base) return { success: false, output: "", error: "Invalid 'base' date.  Pass an ISO 8601 string or 'now'." };

      if (op === "format") {
        return {
          success: true,
          output: base.toISOString(),
          metadata: { operation: "format", iso: base.toISOString(), unixMs: base.getTime() },
        };
      }

      const dur = String(args["duration"] ?? "").trim();
      const parts = parseDuration(dur);
      if (!parts) return { success: false, output: "", error: `Invalid 'duration' '${dur}'.  Examples: '5d', '90 minutes', '6 months'.` };

      const sign = op === "subtract" ? -1 : 1;
      const result = applyDuration(base, {
        ms: parts.ms * sign,
        months: parts.months * sign,
        years: parts.years * sign,
      });
      return {
        success: true,
        output: result.toISOString(),
        metadata: { operation: op, base: base.toISOString(), duration: dur, result: result.toISOString() },
      };
    }

    // diff
    const start = parseDate(String(args["base"] ?? ""));
    const end = parseDate(String(args["target"] ?? ""));
    if (!start || !end) return { success: false, output: "", error: "Both 'base' and 'target' must be ISO 8601 strings or 'now' for diff." };
    const unit = String(args["unit"] ?? "days");
    const ms = end.getTime() - start.getTime();
    const divisor =
      unit === "ms" ? 1 :
      unit === "seconds" ? 1000 :
      unit === "minutes" ? 60_000 :
      unit === "hours" ? 3_600_000 :
      86_400_000;
    const value = ms / divisor;
    return {
      success: true,
      output: `${value} ${unit}`,
      metadata: { operation: "diff", start: start.toISOString(), end: end.toISOString(), unit, value, ms },
    };
  },
});

// ─── json_query ──────────────────────────────────────────────────────────────

/**
 * Walk a dot/bracket path through a JSON value.  Supports `.field`,
 * `["field with spaces"]`, `[index]`, and `[*]` (returns every entry of
 * the current array as an array).  Intentionally narrow — we don't
 * implement the full jq surface (no piping, no map, no select), since
 * those are LLM territory.  This tool exists so agents can do `data.users[0].email`
 * without delegating to data_analyst for a one-liner.
 */
function walkJsonPath(root: unknown, path: string): unknown {
  if (!path || path === "$" || path === ".") return root;

  const tokens: Array<{ kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "splat" }> = [];
  let i = 0;
  // strip optional leading $
  if (path[0] === "$") i = 1;
  while (i < path.length) {
    const ch = path[i]!;
    if (ch === ".") { i++; continue; }
    if (ch === "[") {
      const close = path.indexOf("]", i);
      if (close < 0) throw new Error(`Unterminated '[' at offset ${i}`);
      const inside = path.slice(i + 1, close).trim();
      if (inside === "*") tokens.push({ kind: "splat" });
      else if (/^-?\d+$/.test(inside)) tokens.push({ kind: "index", index: Number(inside) });
      else if ((inside.startsWith('"') && inside.endsWith('"')) || (inside.startsWith("'") && inside.endsWith("'"))) {
        tokens.push({ kind: "key", key: inside.slice(1, -1) });
      } else {
        tokens.push({ kind: "key", key: inside });
      }
      i = close + 1;
      continue;
    }
    // bare key: read until next . or [
    let j = i;
    while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
    tokens.push({ kind: "key", key: path.slice(i, j) });
    i = j;
  }

  let cursor: unknown = root;
  for (const tok of tokens) {
    if (cursor == null) return null;
    if (tok.kind === "splat") {
      if (!Array.isArray(cursor)) throw new Error("[*] applied to non-array");
      return cursor.map((item) => item);
    }
    if (tok.kind === "index") {
      if (!Array.isArray(cursor)) throw new Error(`[${tok.index}] applied to non-array`);
      const idx = tok.index < 0 ? cursor.length + tok.index : tok.index;
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor !== "object") throw new Error(`Cannot read key '${tok.key}' on a ${typeof cursor}`);
    cursor = (cursor as Record<string, unknown>)[tok.key];
  }
  return cursor;
}

registerTool({
  name: "json_query",
  description:
    "Tier-0 jq-lite — extract a value from a JSON document via a path expression. " +
    "Supports dot keys (`.users.name`), bracket keys (`['user-id']`), array indexes (`[0]`, `[-1]`), and array splat (`[*]`). " +
    "Use when an agent has JSON in hand and just needs a sub-value or a list — avoids delegating to data_analyst for a one-liner. " +
    "For complex transforms (filter, map, reduce) keep using the LLM directly.",
  embeddingDescription:
    "Extract a field from JSON.  Get a value by path.  jq query, json path, lookup nested key, get array element.  JSON-Wert auslesen, Pfad-Ausdruck, Feld holen, Array-Element.",
  parameters: {
    type: "object",
    properties: {
      json: {
        oneOf: [
          { type: "string", description: "Stringified JSON document." },
          { type: "object", description: "Already-parsed JSON object." },
          { type: "array", description: "Already-parsed JSON array." },
        ],
        description: "The JSON document to query.  Strings are parsed; objects/arrays are used as-is.",
      },
      path: {
        type: "string",
        description: "Path expression like 'users[0].name', '$.results[*].id', 'data[\"first.name\"]'.  Empty / '.' / '$' returns the whole document.",
      },
    },
    required: ["json", "path"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    let parsed: unknown = args["json"];
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); }
      catch (err) { return { success: false, output: "", error: `Invalid JSON input: ${(err as Error).message}` }; }
    }
    const path = String(args["path"] ?? "");
    try {
      const result = walkJsonPath(parsed, path);
      return {
        success: true,
        output: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        metadata: { path, type: Array.isArray(result) ? "array" : result === null ? "null" : typeof result },
      };
    } catch (err) {
      return { success: false, output: "", error: `Path resolve failed: ${(err as Error).message}` };
    }
  },
});

// ─── regex_test ──────────────────────────────────────────────────────────────

registerTool({
  name: "regex_test",
  description:
    "Tier-0 regex sanity check — run a regular expression against sample text and return all matches with capture groups and offsets. " +
    "Avoids the LLM hallucinating regex semantics.  Use to verify a pattern before code_analyst writes it into source, or to extract structured data from a one-off string.",
  embeddingDescription:
    "Test a regular expression.  Match pattern, capture groups, find all occurrences in text, regex check.  Regex testen, Muster prüfen, Treffer finden, Capture-Gruppen.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The regex source (without the surrounding `/.../`).",
      },
      flags: {
        type: "string",
        description: "Standard JS regex flags — combination of g, i, m, s, u, y.  Defaults to 'g' so all matches are returned.",
        default: "g",
      },
      text: {
        type: "string",
        description: "Text to test the pattern against.",
      },
      maxMatches: {
        type: "integer",
        description: "Cap on the number of matches returned (default 50, max 500).",
        default: 50,
      },
    },
    required: ["pattern", "text"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(args["pattern"] ?? "");
    const flags = String(args["flags"] ?? "g");
    const text = String(args["text"] ?? "");
    const cap = Math.min(500, Math.max(1, Number(args["maxMatches"] ?? 50)));

    if (!pattern) return { success: false, output: "", error: "pattern is required" };

    let re: RegExp;
    try { re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g"); }
    catch (err) { return { success: false, output: "", error: `Invalid regex: ${(err as Error).message}` }; }

    const matches: Array<{ match: string; index: number; groups: string[] }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && matches.length < cap) {
      matches.push({
        match: m[0],
        index: m.index,
        groups: m.slice(1).map((g) => g ?? ""),
      });
      // guard against zero-width matches that would loop forever
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }

    const summary = matches.length === 0
      ? `No matches.`
      : `${matches.length} match${matches.length === 1 ? "" : "es"}:\n` +
        matches.map((mm, i) => `  ${i + 1}. [${mm.index}] "${mm.match}"${mm.groups.length ? ` groups=[${mm.groups.map((g) => JSON.stringify(g)).join(", ")}]` : ""}`).join("\n");

    return {
      success: true,
      output: summary,
      metadata: { pattern, flags, matchCount: matches.length, matches },
    };
  },
});

// ─── url_inspect ─────────────────────────────────────────────────────────────

registerTool({
  name: "url_inspect",
  description:
    "Tier-0 URL probe — HEAD-request a URL and return status code, final URL after redirects, content-type, content-length, server header. " +
    "Body is never fetched, so this is cheap to run on a long list and safe to run on uncertain URLs (a 404 / DNS-fail / TLS-fail surfaces as a structured result, not as a long timeout). " +
    "Use to verify that a citation is alive, check that an API endpoint is reachable, inspect redirect chains, or peek at a download's size before deciding whether to fetch.",
  embeddingDescription:
    "Probe a URL.  Check if a link is alive, fetch headers only, inspect redirect chain, get content type and size without downloading.  URL prüfen, Verfügbarkeit, Weiterleitungen, Header inspizieren.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute URL to probe (http or https)." },
      followRedirects: {
        type: "boolean",
        description: "Follow 30x redirects to the final destination (default true).  When false, the first 30x response is returned with the Location header in the metadata.",
        default: true,
      },
      timeoutMs: {
        type: "integer",
        description: "Timeout in milliseconds (default 8 000, max 30 000).",
        default: 8000,
      },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = String(args["url"] ?? "").trim();
    if (!url) return { success: false, output: "", error: "url is required" };
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { return { success: false, output: "", error: `Invalid URL: '${url}'` }; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { success: false, output: "", error: `Unsupported protocol '${parsed.protocol}' — only http(s) is allowed` };
    }

    const followRedirects = args["followRedirects"] !== false;
    const timeoutMs = Math.min(30_000, Math.max(1_000, Number(args["timeoutMs"] ?? 8000)));

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetch(parsed.toString(), {
        method: "HEAD",
        redirect: followRedirects ? "follow" : "manual",
        signal: ctrl.signal,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      const finalUrl = res.url || parsed.toString();
      const redirected = finalUrl !== parsed.toString();
      const lines = [
        `${res.status} ${res.statusText || ""}`.trim(),
        `final: ${finalUrl}${redirected ? " (redirected)" : ""}`,
        ...(headers["content-type"] ? [`content-type: ${headers["content-type"]}`] : []),
        ...(headers["content-length"] ? [`content-length: ${headers["content-length"]}`] : []),
        ...(headers["server"] ? [`server: ${headers["server"]}`] : []),
        ...(headers["last-modified"] ? [`last-modified: ${headers["last-modified"]}`] : []),
        ...(!followRedirects && headers["location"] ? [`location: ${headers["location"]}`] : []),
      ];
      return {
        success: res.status < 400,
        output: lines.join("\n"),
        metadata: {
          status: res.status,
          finalUrl,
          redirected,
          contentType: headers["content-type"] ?? null,
          contentLength: headers["content-length"] ? Number(headers["content-length"]) : null,
          server: headers["server"] ?? null,
          headers,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: "",
        error: ctrl.signal.aborted ? `URL probe timed out after ${timeoutMs}ms` : `URL probe failed: ${msg}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
});

// ─── text_diff ───────────────────────────────────────────────────────────────

/**
 * Tiny line-level diff using the longest-common-subsequence (LCS) idea.
 * Not a full Myers diff — but for two snippets up to a few thousand lines
 * the O(n*m) cost is irrelevant and the output is a recognizable unified
 * diff.  Avoids pulling in a diff library for a tier-0 utility.
 */
function lineDiff(beforeLines: string[], afterLines: string[]): Array<{ kind: "ctx" | "del" | "add"; text: string; lineA?: number; lineB?: number }> {
  const m = beforeLines.length;
  const n = afterLines.length;
  // LCS table
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (beforeLines[i] === afterLines[j]) lcs[i]![j] = lcs[i + 1]![j + 1]! + 1;
      else lcs[i]![j] = Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: Array<{ kind: "ctx" | "del" | "add"; text: string; lineA?: number; lineB?: number }> = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (beforeLines[i] === afterLines[j]) { out.push({ kind: "ctx", text: beforeLines[i]!, lineA: i + 1, lineB: j + 1 }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { out.push({ kind: "del", text: beforeLines[i]!, lineA: i + 1 }); i++; }
    else { out.push({ kind: "add", text: afterLines[j]!, lineB: j + 1 }); j++; }
  }
  while (i < m) { out.push({ kind: "del", text: beforeLines[i]!, lineA: i + 1 }); i++; }
  while (j < n) { out.push({ kind: "add", text: afterLines[j]!, lineB: j + 1 }); j++; }
  return out;
}

registerTool({
  name: "text_diff",
  description:
    "Tier-0 line-by-line unified diff between two text strings.  No git or filesystem access required — pass `before` and `after` directly. " +
    "Returns a unified-diff-style summary plus structured metadata (lines added / deleted / unchanged + the changed-line list). " +
    "Use for comparing two drafts, expected-vs-actual output, two snippets pulled from different sources, or to give the LLM a precise structural picture of what changed.",
  embeddingDescription:
    "Compare two pieces of text.  Show what changed between two strings, line diff, before / after, draft comparison, expected vs actual.  Texte vergleichen, Unterschiede anzeigen, Zeilenvergleich.",
  parameters: {
    type: "object",
    properties: {
      before: { type: "string", description: "Original text (the 'a' side of the diff)." },
      after: { type: "string", description: "Updated text (the 'b' side of the diff)." },
      contextLines: {
        type: "integer",
        description: "Unchanged lines of context to keep around each change (default 3, max 20).",
        default: 3,
      },
    },
    required: ["before", "after"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const before = String(args["before"] ?? "");
    const after = String(args["after"] ?? "");
    const contextLines = Math.min(20, Math.max(0, Number(args["contextLines"] ?? 3)));

    const beforeLines = before.split(/\r?\n/);
    const afterLines = after.split(/\r?\n/);
    const ops = lineDiff(beforeLines, afterLines);

    let added = 0;
    let deleted = 0;
    for (const op of ops) {
      if (op.kind === "add") added++;
      else if (op.kind === "del") deleted++;
    }

    if (added === 0 && deleted === 0) {
      return {
        success: true,
        output: "(no differences)",
        metadata: { added: 0, deleted: 0, unchanged: ops.length, identical: true },
      };
    }

    // Render with limited context — collapse runs of unchanged lines that
    // are far from any change into a "@@ ... @@" marker.
    const rendered: string[] = [];
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k]!;
      if (op.kind === "ctx") {
        // determine distance to nearest change in either direction
        const nextChange = ops.slice(k + 1).findIndex((o) => o.kind !== "ctx");
        const prevChange = (() => {
          for (let p = k - 1; p >= 0; p--) if (ops[p]!.kind !== "ctx") return k - p;
          return Infinity;
        })();
        const distNext = nextChange < 0 ? Infinity : nextChange + 1;
        if (Math.min(distNext, prevChange) <= contextLines) {
          rendered.push(`  ${op.text}`);
        } else if (rendered.length > 0 && rendered[rendered.length - 1] !== "@@") {
          rendered.push("@@");
        }
        continue;
      }
      rendered.push(op.kind === "add" ? `+ ${op.text}` : `- ${op.text}`);
    }

    return {
      success: true,
      output: `+${added} -${deleted}\n${rendered.join("\n")}`,
      metadata: {
        added,
        deleted,
        unchanged: ops.length - added - deleted,
        identical: false,
        changedLines: ops.filter((o) => o.kind !== "ctx").map((o) => ({ kind: o.kind, line: o.lineA ?? o.lineB ?? 0, text: o.text })),
      },
    };
  },
});

// ─── hash_compute ────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

registerTool({
  name: "hash_compute",
  description:
    "Tier-0 cryptographic hash of a UTF-8 string — supports md5, sha1, sha256, sha512 (and any other algorithm node:crypto recognizes). " +
    "Returns the hex digest plus optional first-N-character prefix (handy for short fingerprints).  Use for content fingerprints, dedup checks, or comparing two strings without leaking the content into logs.",
  embeddingDescription:
    "Hash a string.  Compute md5 / sha256 / fingerprint / digest of text.  String hashen, Prüfsumme berechnen, Hash erzeugen, sha256.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "UTF-8 text to hash." },
      algorithm: {
        type: "string",
        enum: ["md5", "sha1", "sha256", "sha512"],
        description: "Hash algorithm.  Defaults to sha256.",
        default: "sha256",
      },
      truncate: {
        type: "integer",
        description: "When set, return only the first N characters of the hex digest (default 0 = full digest).",
        default: 0,
      },
    },
    required: ["text"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const text = String(args["text"] ?? "");
    const algorithm = String(args["algorithm"] ?? "sha256").toLowerCase();
    const truncate = Math.max(0, Math.min(128, Number(args["truncate"] ?? 0)));

    let digest: string;
    try {
      digest = createHash(algorithm).update(text, "utf8").digest("hex");
    } catch (err) {
      return { success: false, output: "", error: `Hash failed: ${(err as Error).message}` };
    }
    const out = truncate > 0 ? digest.slice(0, truncate) : digest;
    return {
      success: true,
      output: out,
      metadata: { algorithm, length: out.length, fullDigestLength: digest.length, truncated: truncate > 0 },
    };
  },
});
