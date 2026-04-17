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
import { resolvePathWithinWorkspace } from "./workspace-path.js";
import { open, stat } from "node:fs/promises";

const log = childLogger("tool:log-stream");
const execFileAsync = promisify(execFile);

const DEFAULT_TAIL = 100;
const MAX_TAIL = 500;
const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
/** Read only the last N bytes of a file — avoids OOM on multi-GB logs. */
const FILE_TAIL_BYTES = 512 * 1024;

registerTool({
  name: "log_stream",
  description:
    "Tail recent log lines from a Docker Compose service container or a workspace log file. " +
    "For container logs, provide serviceName (e.g. 'gateway', 'agent-worker'). " +
    "For file logs, provide filePath (workspace-relative). " +
    "Returns the last N lines, optionally filtered by a grep pattern. " +
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

      const dockerArgs = ["compose", "logs", "--no-color", "--tail", String(tail)];
      if (since) dockerArgs.push("--since", since);
      dockerArgs.push(serviceName);

      log.info({ serviceName, tail, since, sessionId: ctx.sessionId }, "log_stream container");

      try {
        const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          cwd: ctx.workspacePath,
        });
        let output = [stdout, stderr].filter(Boolean).join("\n");
        if (filter) {
          output = output
            .split("\n")
            .filter((line) => line.toLowerCase().includes(filter))
            .join("\n");
        }
        return {
          success: true,
          output: output.trim() || "(no log lines matched)",
          metadata: { serviceName, tail, since: since || undefined, filter: filter || undefined },
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
    let resolvedFilePath: string;
    try {
      resolvedFilePath = resolvePathWithinWorkspace(filePathRaw, ctx.workspacePath).resolved;
    } catch {
      return {
        success: false,
        output: "",
        error: "filePath must be within the workspace directory.",
      };
    }

    log.info({ filePath: resolvedFilePath, tail, sessionId: ctx.sessionId }, "log_stream file");

    try {
      const fileStat = await stat(resolvedFilePath);
      const readStart = Math.max(0, fileStat.size - FILE_TAIL_BYTES);
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
      let lines = content.split("\n");
      if (filter) {
        lines = lines.filter((line) => line.toLowerCase().includes(filter));
      }
      const sliced = lines.slice(-tail).join("\n");
      return {
        success: true,
        output: sliced.trim() || "(no log lines matched)",
        metadata: { filePath: filePathRaw, tail, filter: filter || undefined, truncated: readStart > 0 },
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
