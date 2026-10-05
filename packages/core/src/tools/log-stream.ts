/**
 * Tier 1 (read, audit-logged, no per-call approval) — Tail container or workspace log files.
 *
 * Fetches recent log lines from a named Docker Compose service container or
 * reads a workspace log file.  Read-only — does not modify any state.
 * Output is bounded by a line cap and an optional time window.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { guardPath } from "./filesystem.js";
import { open, stat } from "node:fs/promises";

const log = childLogger("tool:log-stream");
const execFileAsync = promisify(execFile);

const DEFAULT_TAIL = 100;
const MAX_TAIL = 500;
const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
/** Read only the last N bytes of a file — avoids OOM on multi-GB logs. */
const FILE_TAIL_BYTES = 512 * 1024;
/**
 * How far back a FILTERED read looks. A filter used to run over the same window as a plain tail —
 * the last `tail` lines of a container, the last 512 KB of a file — so a match one line before that
 * window answered "(no log lines matched)", which reads as "this never happened". A filter now
 * searches this much, then the tail applies to the matches, and the answer names the window.
 */
const FILTER_SCAN_LINES = 10_000;
const FILTER_SCAN_MAX_BYTES = 16 * 1024 * 1024;
const FILTER_SCAN_FILE_BYTES = 32 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Filter, tail, and say what was searched: the lines shown, then one line naming the window. */
function renderLogWindow(lines: string[], opts: { filter: string; tail: number; window: string }): { output: string; matched: number; shown: number } {
  const body = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const matched = opts.filter ? body.filter((line) => line.toLowerCase().includes(opts.filter)) : body;
  const shown = matched.slice(-opts.tail);
  const text = shown.join("\n").trim();
  const summary = opts.filter
    ? `[log_stream: ${matched.length} line(s) matching "${opts.filter}" in ${opts.window}`
      + (matched.length > shown.length ? `; showing the last ${shown.length} — raise tail (max ${MAX_TAIL}) for more` : "") + "]"
    : `[log_stream: showing the last ${shown.length} line(s) of ${opts.window}]`;
  return {
    output: `${text || (opts.filter ? `(no log lines matched "${opts.filter}")` : "(log is empty)")}\n\n${summary}`,
    matched: matched.length,
    shown: shown.length,
  };
}

registerTool({
  name: "log_stream",
  description:
    "Tail recent log lines from a Docker Compose service container or a workspace log file. " +
    "For container logs, provide serviceName (e.g. 'gateway', 'agent-worker'). " +
    "For file logs, provide filePath (workspace-relative). " +
    "Returns the last N lines; with a filter, the last N MATCHING lines from a deeper window " +
    `(the last ${FILTER_SCAN_LINES} container lines, or the last ${FILTER_SCAN_FILE_BYTES / (1024 * 1024)} MB of a file). ` +
    "The answer always names the window it searched. " +
    "Read-only — does not modify container state.",
  parameters: {
    type: "object",
    properties: {
      serviceName: {
        type: "string",
        description:
          "Docker Compose service name to read logs from (e.g. 'gateway', 'agent-worker', 'mail-service'). " +
          "Mutually exclusive with filePath.",
      },
      filePath: {
        type: "string",
        description:
          "Workspace-relative path to a log file to tail (e.g. 'logs/app.log'). " +
          "Mutually exclusive with serviceName.",
      },
      tail: {
        type: "number",
        description: `Number of lines to return (default: ${DEFAULT_TAIL}, max: ${MAX_TAIL}).`,
        default: DEFAULT_TAIL,
      },
      since: {
        type: "string",
        description:
          "Only show logs newer than this duration (Docker format: '5m', '1h', '2h30m'). " +
          "Applies only to container logs, ignored for file logs.",
      },
      filter: {
        type: "string",
        description:
          "Optional case-insensitive substring filter — only lines containing this string are returned.",
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const serviceName = args["serviceName"] != null ? String(args["serviceName"]).trim() : "";
    const filePathRaw = args["filePath"] != null ? String(args["filePath"]).trim() : "";
    const tail = Math.min(Math.max(Number(args["tail"] ?? DEFAULT_TAIL), 1), MAX_TAIL);
    const since = args["since"] != null ? String(args["since"]).trim() : "";
    const filter = args["filter"] != null ? String(args["filter"]).toLowerCase().trim() : "";

    if (!serviceName && !filePathRaw) {
      return {
        success: false,
        output: "",
        error: "Either serviceName or filePath is required.",
      };
    }
    if (serviceName && filePathRaw) {
      return {
        success: false,
        output: "",
        error: "Provide either serviceName or filePath, not both.",
      };
    }

    // ── Container log path ───────────────────────────────────────────────────
    if (serviceName) {
      // Validate service name: alphanumeric + hyphens/underscores only
      if (!/^[a-zA-Z0-9_-]+$/.test(serviceName)) {
        return { success: false, output: "", error: "Invalid serviceName format." };
      }

      // A filter searches a deep window (narrowed by --since first, when given) and the tail then
      // applies to the matches; without one, the tail is the window.
      const scanLines = filter ? FILTER_SCAN_LINES : tail;
      const dockerArgs = ["compose", "logs", "--no-color", "--tail", String(scanLines)];
      if (since) dockerArgs.push("--since", since);
      dockerArgs.push(serviceName);

      log.info({ serviceName, tail, since, scanLines, sessionId: ctx.sessionId }, "log_stream container");

      try {
        const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: filter ? FILTER_SCAN_MAX_BYTES : MAX_OUTPUT_BYTES,
          cwd: ctx.workspacePath,
        });
        const lines = [stdout, stderr].filter(Boolean).join("\n").split("\n");
        const returned = lines.filter(Boolean).length;
        const source = `${serviceName}'s log${since ? ` since ${since}` : ""}`;
        const window = returned < scanLines
          ? `all ${returned} line(s) of ${source}`
          : filter
            ? `the last ${scanLines} lines of ${source} (older lines were not searched)`
            : `${source} (older lines not shown)`;
        const rendered = renderLogWindow(lines, { filter, tail, window });
        return {
          success: true,
          output: rendered.output,
          metadata: { serviceName, tail, since: since || undefined, filter: filter || undefined, scannedLines: scanLines, matched: rendered.matched },
        };
      } catch (err: unknown) {
        const e = err as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
        if (e.killed) {
          return { success: false, output: e.stdout ?? "", error: "log_stream timed out" };
        }
        const detail = [e.stdout, e.stderr].filter(Boolean).join("\n");
        return {
          success: false,
          output: detail,
          error: `docker compose logs failed: ${e.message?.split("\n")[0] ?? "unknown error"}`,
        };
      }
    }

    // ── Workspace file log path ──────────────────────────────────────────────
    // read_file's guard, not just the workspace boundary: a log tail is a file read, and
    // `.env`, `.starlingai/…` or `.git/…` must not come back through it any more than through read_file.
    const guarded = guardPath(filePathRaw, ctx.workspacePath);
    if (!guarded.safe) {
      return {
        success: false,
        output: "",
        error: "filePath must be a non-protected file within the workspace directory.",
      };
    }
    const resolvedFilePath = guarded.resolved;

    log.info({ filePath: resolvedFilePath, tail, sessionId: ctx.sessionId }, "log_stream file");

    try {
      const fileStat = await stat(resolvedFilePath);
      if (fileStat.isDirectory()) {
        return { success: false, output: "", error: `${filePathRaw} is a directory, not a log file — use list_files to see what it holds.` };
      }
      const readStart = Math.max(0, fileStat.size - (filter ? FILTER_SCAN_FILE_BYTES : FILE_TAIL_BYTES));
      const readLength = fileStat.size - readStart;
      const buffer = Buffer.alloc(readLength);
      const handle = await open(resolvedFilePath, "r");
      try {
        await handle.read(buffer, 0, readLength, readStart);
      } finally {
        await handle.close();
      }
      // Drop the (potentially partial) first line when we didn't read from offset 0.
      let content = buffer.toString("utf8");
      if (readStart > 0) {
        const firstNl = content.indexOf("\n");
        if (firstNl >= 0) content = content.slice(firstNl + 1);
      }
      const lines = content.split("\n");
      const lineCount = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      const window = readStart > 0
        ? `the last ${formatBytes(readLength)} of ${filePathRaw} (${lineCount} lines; the first ${formatBytes(readStart)} of the ${formatBytes(fileStat.size)} file were not searched)`
        : `the whole of ${filePathRaw} (${lineCount} lines)`;
      const rendered = renderLogWindow(lines, { filter, tail, window });
      return {
        success: true,
        output: rendered.output + (since ? "\n[since applies to container logs only; it was not applied to this file]" : ""),
        metadata: { filePath: filePathRaw, tail, filter: filter || undefined, truncated: readStart > 0, matched: rendered.matched },
      };
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e.code === "ENOENT") {
        return { success: false, output: "", error: `Log file not found: ${filePathRaw}` };
      }
      return {
        success: false,
        output: "",
        error: `Failed to read log file: ${e.message ?? "unknown error"}`,
      };
    }
  },
});
