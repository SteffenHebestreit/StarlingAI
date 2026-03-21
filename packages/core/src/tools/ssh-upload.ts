import { execFile } from "node:child_process";
import { statSync } from "node:fs";
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

const log = childLogger("tool:ssh-upload");
const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;

registerTool({
  name: "ssh_upload",
  description: "Upload a workspace file or directory to a remote host over SCP. Use for deployment artifacts, compose files, and configuration bundles.",
  parameters: {
    type: "object",
    properties: {
      host: { type: "string", description: "The hostname or IP address of the target machine." },
      username: { type: "string", description: "The SSH username to connect with.", default: "root" },
      port: { type: "number", description: "Optional SSH port. Defaults to 22." },
      sourcePath: { type: "string", description: "Workspace-relative file or directory to upload." },
      destinationPath: { type: "string", description: "Remote destination path." },
      recursive: { type: "boolean", description: "Whether to upload directories recursively." },
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
    const destinationPath = String(args["destinationPath"] ?? "").trim();
    const sourcePathInput = String(args["sourcePath"] ?? "").trim();
    const privateKeyPath = typeof args["privateKeyPath"] === "string" ? String(args["privateKeyPath"]).trim() : undefined;
    const recursive = args["recursive"] === true;
    const port = normalizePort(args["port"]);
    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"], DEFAULT_TIMEOUT_MS);

    if (!host || !sourcePathInput || !destinationPath) {
      return { success: false, output: "", error: "host, sourcePath, and destinationPath are required" };
    }
    if (!isSafeConnectionTarget(host) || !isSafeConnectionTarget(username)) {
      return { success: false, output: "", error: "Host and username must not contain whitespace or shell control characters." };
    }
    if (!isSafeRemotePath(destinationPath)) {
      return { success: false, output: "", error: "destinationPath must not contain line breaks or shell separators." };
    }

    const sourcePath = resolveWorkspaceRelativePath(sourcePathInput, ctx.workspacePath);
    const sourceStat = statSync(sourcePath);
    if (sourceStat.isDirectory() && !recursive) {
      return { success: false, output: "", error: "sourcePath is a directory; set recursive=true to upload directories." };
    }

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

    processArgs.push(sourcePath, `${username}@${host}:${destinationPath}`);

    log.debug({ host, username, sourcePath, destinationPath, recursive }, "Uploading file over SCP");

    try {
      const { stdout, stderr } = await execFileAsync("scp", processArgs, { timeout: timeoutMs });
      return {
        success: true,
        output: `${stdout}\n${stderr}`.trim() || `Uploaded ${sourcePathInput} to ${username}@${host}:${destinationPath}`,
        metadata: {
          host,
          username,
          port,
          sourcePath: sourcePathInput,
          destinationPath,
          recursive,
        },
      };
    } catch (error: any) {
      log.error({ err: error }, "SCP upload failed");
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`.trim(),
        error: formatCliExecutionError(
          error,
          "scp",
          "Execution timed out. Ensure the host is reachable and the upload completes within the timeout.",
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