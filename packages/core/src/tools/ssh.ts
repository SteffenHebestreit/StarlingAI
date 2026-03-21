import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import {
  formatCliExecutionError,
  isSafeConnectionTarget,
  normalizeExecutionTimeout,
} from "./infrastructure-shared.js";

const log = childLogger("tool:ssh");
const execFileAsync = promisify(execFile);

// Increased timeout as remote config might pull large images/packages
const EXEC_TIMEOUT_MS = 60_000;
registerTool({
  name: "ssh_exec",
  description: "Execute a command remotely over SSH from the host. Use for privileged operations on infrastructure you control.",
  parameters: {
    type: "object",
    properties: {
      host: { type: "string", description: "The hostname or IP address of the target machine." },
      username: { type: "string", description: "The SSH username to connect with.", default: "root" },
      port: { type: "number", description: "Optional SSH port. Defaults to 22." },
      command: { type: "string", description: "The command to run securely on the remote host." },
      privateKeyPath: { 
        type: "string", 
        description: "Path to SSH private key. If not provided, relies on agent forwarding or default path /root/.ssh/id_rsa." 
      },
      timeoutMs: {
        type: "number",
        description: "Optional execution timeout in milliseconds. Defaults to 60000 and is capped at 900000.",
      },
    },
    required: ["host", "command"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const host = String(args["host"] ?? "");
    const username = String(args["username"] ?? "root");
    const port = normalizePort(args["port"]);
    const command = String(args["command"] ?? "");
    const privateKeyPath = args["privateKeyPath"] ? String(args["privateKeyPath"]) : undefined;
    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"], EXEC_TIMEOUT_MS);

    if (!host.trim() || !command.trim()) {
      return { success: false, output: "", error: "Host and command cannot be empty." };
    }

    if (!isSafeConnectionTarget(host) || !isSafeConnectionTarget(username)) {
      return { success: false, output: "", error: "Host and username must not contain whitespace or shell control characters." };
    }

    const processArgs: string[] = [
      "-o", "BatchMode=yes", // Prevent arbitrary prompts that hang the command
      "-o", "StrictHostKeyChecking=accept-new", // Accept new host keys automatically
      "-o", "ConnectTimeout=10",
      "-T", // Do not allocate a pseudo-terminal
    ];

    if (privateKeyPath) {
      processArgs.push("-i", privateKeyPath);
    }

    processArgs.push("-p", String(port));

    processArgs.push(`${username}@${host}`);
    processArgs.push(command);

    log.debug({ host, port, username, command: command.split(" ")[0] }, "Executing SSH command");

    try {
      const { stdout, stderr } = await execFileAsync("ssh", processArgs, {
        timeout: timeoutMs,
      });

      return {
        success: true,
        output: `${stdout}\n${stderr}`.trim(),
      };
    } catch (error: any) {
      log.error({ err: error }, "SSH execution failed");
      
      const errOutput = `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`;
      return {
        success: false,
        output: errOutput.trim(),
        error: formatCliExecutionError(
          error,
          "ssh",
          "Execution timed out. Ensure the host is reachable and the command completes within the timeout.",
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

