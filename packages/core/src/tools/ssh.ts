import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { getConfig } from "../config/loader.js";
import type { ComputerUseConfig, NodeEntry } from "../config/computer-use-schema.js";
import { childLogger } from "../logger.js";
import {
  formatCliExecutionError,
  isSafeConnectionTarget,
  normalizeExecutionTimeout,
  resolveSecretRef,
} from "./infrastructure-shared.js";

const log = childLogger("tool:ssh");
const execFileAsync = promisify(execFile);

// Increased timeout as remote config might pull large images/packages
const EXEC_TIMEOUT_MS = 60_000;
registerTool({
  name: "ssh_exec",
  description: "Execute a command remotely over SSH from the host. Use for privileged operations on infrastructure you control.",
  embeddingDescription: "Run, execute command remotely via SSH on a remote server or host. SSH-Befehl ausführen, Remote-Kommando, Fernwartung, Server-Shell. Remote shell, privileged operations.",
  parameters: {
    type: "object",
    properties: {
      nodeName: {
        type: "string",
        description: "Optional name of a configured remote_ssh node from computerUse.nodes. When provided, the tool resolves host, port, username, and configured credentials automatically.",
      },
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
    required: ["command"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const nodeName = String(args["nodeName"] ?? "").trim();
    const configuredNode = nodeName ? resolveConfiguredSshNode(nodeName) : null;
    if (configuredNode?.error) {
      return { success: false, output: "", error: configuredNode.error };
    }

    const host = String(args["host"] ?? configuredNode?.host ?? "").trim();
    const username = String(args["username"] ?? configuredNode?.username ?? "root").trim();
    const port = normalizePort(args["port"] ?? configuredNode?.port);
    const command = String(args["command"] ?? "");
    const privateKeyPath = resolveSecretRef(args["privateKeyPath"] ? String(args["privateKeyPath"]) : configuredNode?.privateKeyPath);
    const password = resolveSecretRef(configuredNode?.password);
    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"], EXEC_TIMEOUT_MS);

    if (!host || !command.trim()) {
      return { success: false, output: "", error: "Either nodeName or host must be provided, and command cannot be empty." };
    }

    if (!isSafeConnectionTarget(host) || !isSafeConnectionTarget(username)) {
      return { success: false, output: "", error: "Host and username must not contain whitespace or shell control characters." };
    }

    const processArgs: string[] = [
      "-o", "StrictHostKeyChecking=accept-new", // Accept new host keys automatically
      "-o", "ConnectTimeout=10",
      "-T", // Do not allocate a pseudo-terminal
    ];

    if (!password) {
      processArgs.unshift("-o", "BatchMode=yes"); // Prevent arbitrary prompts that hang key-based runs
    }

    if (privateKeyPath) {
      processArgs.push("-i", privateKeyPath);
    }

    processArgs.push("-p", String(port));

    processArgs.push(`${username}@${host}`);
    processArgs.push(command);

    log.debug({ host, nodeName: nodeName || undefined, port, username, command: command.split(" ")[0] }, "Executing SSH command");

    try {
      const binary = password ? "sshpass" : "ssh";
      const execArgs = password ? ["-p", password, "ssh", ...processArgs] : processArgs;

      const { stdout, stderr } = await execFileAsync(binary, execArgs, {
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
          password ? "sshpass/ssh" : "ssh",
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

function resolveConfiguredSshNode(nodeName: string): {
  host: string;
  username: string;
  port: number;
  privateKeyPath?: string;
  password?: string;
  error?: string;
} | null {
  const config = getConfig();
  const computerUse = config.computerUse as Partial<ComputerUseConfig> | undefined;
  const rawNode = computerUse?.nodes?.[nodeName] as (NodeEntry & Record<string, unknown>) | undefined;

  if (!rawNode) {
    return { host: "", username: "root", port: 22, error: `Configured SSH node '${nodeName}' was not found.` };
  }
  if (rawNode.adapter !== "remote_ssh") {
    return { host: "", username: "root", port: 22, error: `Configured node '${nodeName}' is not a remote_ssh target.` };
  }

  const host = typeof rawNode.host === "string" ? rawNode.host.trim() : "";
  const username = typeof rawNode.username === "string" ? rawNode.username.trim() : "root";
  const port = normalizePort(rawNode.port);
  const authMethod = rawNode.authMethod === "key" ? "key" : rawNode.authMethod === "password" ? "password" : undefined;
  const credentials = typeof rawNode.credentials === "string" ? rawNode.credentials : undefined;

  if (!host) {
    return { host: "", username, port, error: `Configured SSH node '${nodeName}' is missing its host.` };
  }

  if (authMethod === "password") {
    const password = resolveSecretRef(credentials);
    if (!password) {
      return { host, username, port, error: `Configured SSH node '${nodeName}' requires a password, but its credential reference could not be resolved.` };
    }
    return { host, username, port, password };
  }

  if (authMethod === "key") {
    const privateKeyPath = resolveSecretRef(credentials);
    return { host, username, port, ...(privateKeyPath ? { privateKeyPath } : {}) };
  }

  return { host, username, port };
}

