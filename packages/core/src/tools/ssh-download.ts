import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import {
  formatCliExecutionError,
  isSafeConnectionTarget,
  isSafeRemotePath,
  normalizeExecutionTimeout,
  resolveWorkspaceRelativePath,
} from "./infrastructure-shared.js";

const log = childLogger("tool:ssh-download");
const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;

registerTool({
  name: "ssh_download",
  description: "Download a file or directory from a remote host into the workspace over SCP. Use for deployment logs, generated configs, and built artifacts.",
  parameters: {
    type: "object",
    properties: {
      host: { type: "string", description: "The hostname or IP address of the target machine." },
      username: { type: "string", description: "The SSH username to connect with.", default: "root" },
      port: { type: "number", description: "Optional SSH port. Defaults to 22." },
      sourcePath: { type: "string", description: "Remote file or directory to download." },
      destinationPath: { type: "string", description: "Workspace-relative destination path." },
      recursive: { type: "boolean", description: "Whether to download directories recursively." },
      privateKeyPath: {
        type: "string",
        description: "Path to SSH private key. If not provided, relies on agent forwarding or the default key.",
      },
      timeoutMs: {
        type: "number",
        description: "Optional execution timeout in milliseconds. Defaults to 120000 and is capped at 900000.",
      },
    },
    required: ["host", "sourcePath", "destinationPath"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const host = String(args["host"] ?? "").trim();
    const username = String(args["username"] ?? "root").trim();
    const sourcePath = String(args["sourcePath"] ?? "").trim();
    const destinationPathInput = String(args["destinationPath"] ?? "").trim();
    const privateKeyPath = typeof args["privateKeyPath"] === "string" ? String(args["privateKeyPath"]).trim() : undefined;
    const recursive = args["recursive"] === true;
    const port = normalizePort(args["port"]);
    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"], DEFAULT_TIMEOUT_MS);

    if (!host || !sourcePath || !destinationPathInput) {
      return { success: false, output: "", error: "host, sourcePath, and destinationPath are required" };
    }
    if (!isSafeConnectionTarget(host) || !isSafeConnectionTarget(username)) {
      return { success: false, output: "", error: "Host and username must not contain whitespace or shell control characters." };
    }
    if (!isSafeRemotePath(sourcePath)) {
      return { success: false, output: "", error: "sourcePath must not contain line breaks or shell separators." };
    }

    const destinationPath = resolveWorkspaceRelativePath(destinationPathInput, ctx.workspacePath);
    mkdirSync(dirname(destinationPath), { recursive: true });

    const processArgs: string[] = [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "-P", String(port),
    ];

    if (recursive) {
      processArgs.push("-r");
    }
    if (privateKeyPath) {
      processArgs.push("-i", privateKeyPath);
    }

    processArgs.push(`${username}@${host}:${sourcePath}`, destinationPath);

    log.debug({ host, username, sourcePath, destinationPathInput, recursive }, "Downloading file over SCP");

    try {
      const { stdout, stderr } = await execFileAsync("scp", processArgs, { timeout: timeoutMs });
      return {
        success: true,
        output: `${stdout}\n${stderr}`.trim() || `Downloaded ${username}@${host}:${sourcePath} to ${destinationPathInput}`,
        metadata: {
          host,
          username,
          port,
          sourcePath,
          destinationPath: destinationPathInput,
          recursive,
        },
      };
    } catch (error: any) {
      log.error({ err: error }, "SCP download failed");
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`.trim(),
        error: formatCliExecutionError(
          error,
          "scp",
          "Execution timed out. Ensure the host is reachable and the download completes within the timeout.",
        ),
      };
    }
  },
});

function normalizePort(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 22;
  }

  const port = Math.trunc(value);
  if (port < 1 || port > 65_535) {
    return 22;
  }

  return port;
}