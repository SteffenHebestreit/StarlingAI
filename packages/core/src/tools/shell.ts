/**
 * Tier 2 shell execution tool — ALWAYS runs in Docker sandbox.
 * Never executes on the host machine directly.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { resolveDockerWorkspaceMountSource } from "./workspace-mount.js";

const log = childLogger("tool:shell");
const execFileAsync = promisify(execFile);

const SANDBOX_IMAGE = process.env["SAI_SANDBOX_IMAGE"] ?? "starlingai/sandbox:latest";
const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024; // 64KB

registerTool({
  name: "shell_exec",
  description: "Execute a shell command in an isolated Docker sandbox container. The sandbox has no network access and limited filesystem. Use for running scripts, installing tools, compiling code.",
  embeddingDescription: "Run, execute, invoke a shell command, bash script, or CLI tool in a sandbox. Shell-Befehl ausführen, Kommando starten, Skript laufen lassen. Command line execution, terminal, bash, sh.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      workdir: { type: "string", description: "Working directory inside sandbox (default: /workspace)", default: "/workspace" },
      env: {
        type: "object",
        description: "Additional environment variables (key-value pairs)",
        additionalProperties: { type: "string" },
      },
    },
    required: ["command"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = String(args["command"] ?? "");
    const workdir = normalizeWorkdir(String(args["workdir"] ?? "/workspace"));
    const userEnv = (args["env"] as Record<string, string> | undefined) ?? {};

    if (!command.trim()) {
      return { success: false, output: "", error: "Command cannot be empty" };
    }

    if (!workdir) {
      return { success: false, output: "", error: "workdir must stay within /workspace" };
    }

    // Sanity check: reject obviously dangerous commands even inside sandbox
    const dangerousPatterns = [
      /docker\s+(run|exec|socket)/i,
      /--privileged/i,
      /\/var\/run\/docker\.sock/i,
      /nsenter/i,
      /chroot/i,
    ];
    for (const p of dangerousPatterns) {
      if (p.test(command)) {
        return { success: false, output: "", error: `Command pattern not allowed in sandbox: ${p.source}` };
      }
    }

    // Build docker run command
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(userEnv)) {
      if (/^[A-Z_][A-Z0-9_]*$/i.test(k)) {
        envArgs.push("-e", `${k}=${v}`);
      }
    }

    const workspaceMountSource = resolveDockerWorkspaceMountSource(ctx.workspacePath);
    const wrappedCommand = buildSandboxCommand(command, workdir);

    const dockerArgs = [
      "run", "--rm",
      "--network=none",                   // No network access
      "--memory=512m",                    // 512MB RAM limit
      "--cpus=0.5",                       // 50% CPU limit
      "--pids-limit=64",                  // Prevent fork bombs
      "--read-only",                      // Read-only filesystem
      "--tmpfs=/tmp:size=64m",            // Writable /tmp in memory
      "--cap-drop=ALL",                   // Drop all capabilities
      "--security-opt=no-new-privileges",
      "-v", `${workspaceMountSource}:/workspace`,
      "-w", workdir,
      ...envArgs,
      SANDBOX_IMAGE,
      "sh", "-lc", wrappedCommand,
    ];

    log.info({ command: command.substring(0, 200), sessionId: ctx.sessionId }, "shell_exec starting");

    try {
      const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      });

      const output = [stdout, stderr].filter(Boolean).join("\n");
      return {
        success: true,
        output: output || "(no output)",
        metadata: { command, exitCode: 0, sandboxed: true },
      };
    } catch (err: unknown) {
      const e = err as { killed?: boolean; code?: number; stdout?: string; stderr?: string; message?: string };
      if (e.killed) {
        return { success: false, output: e.stdout ?? "", error: `Command timed out after ${EXEC_TIMEOUT_MS}ms` };
      }
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
      return {
        success: false,
        output,
        error: `Exit code ${e.code ?? "?"}: ${e.message ?? "Unknown error"}`,
        metadata: { sandboxed: true },
      };
    }
  },
});

function normalizeWorkdir(workdir: string): string | null {
  const trimmed = workdir.trim() || "/workspace";
  const normalized = trimmed.replace(/\\/g, "/");
  if (!normalized.startsWith("/workspace")) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

function buildSandboxCommand(command: string, workdir: string): string {
  return `mkdir -p ${shellQuote(workdir)} && cd ${shellQuote(workdir)} && ${command}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// ── run_script ────────────────────────────────────────────────────────────────

registerTool({
  name: "run_script",
  description:
    "Execute a script file from the workspace in the Docker sandbox. " +
    "Supports .sh, .py, .js, and .ts files. The script must already exist in the workspace.",
  embeddingDescription: "Run, execute a script file (bash, python, javascript, typescript) from the workspace. Skript ausführen, Python-Datei starten, Node-Script laufen lassen.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative path to the script file (e.g. scripts/deploy.sh)",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass to the script",
        default: [],
      },
      env: {
        type: "object",
        description: "Additional environment variables (key-value pairs)",
        additionalProperties: { type: "string" },
      },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const scriptPath = String(args["path"] ?? "").replace(/\\/g, "/");
    const scriptArgs = (args["args"] as string[] | undefined) ?? [];
    const userEnv = (args["env"] as Record<string, string> | undefined) ?? {};

    if (!scriptPath || scriptPath.includes("..")) {
      return { success: false, output: "", error: "Invalid script path" };
    }

    // Determine interpreter from extension
    const ext = scriptPath.split(".").pop()?.toLowerCase();
    const interpreterMap: Record<string, string> = {
      sh: "bash",
      bash: "bash",
      py: "python3",
      js: "node",
      ts: "npx tsx",
    };
    const interpreter = interpreterMap[ext ?? ""];
    if (!interpreter) {
      return {
        success: false,
        output: "",
        error: `Unsupported script extension .${ext}. Supported: ${Object.keys(interpreterMap).join(", ")}`,
      };
    }

    const sandboxScript = `/workspace/${scriptPath}`;
    const quotedArgs = scriptArgs.map(shellQuote).join(" ");
    const command = `${interpreter} ${shellQuote(sandboxScript)}${quotedArgs ? ` ${quotedArgs}` : ""}`;

    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(userEnv)) {
      if (/^[A-Z_][A-Z0-9_]*$/i.test(k)) {
        envArgs.push("-e", `${k}=${v}`);
      }
    }

    const workspaceMountSource = resolveDockerWorkspaceMountSource(ctx.workspacePath);

    const dockerArgs = [
      "run", "--rm",
      "--network=none",
      "--memory=512m",
      "--cpus=0.5",
      "--pids-limit=64",
      "--read-only",
      "--tmpfs=/tmp:size=64m",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "-v", `${workspaceMountSource}:/workspace`,
      "-w", "/workspace",
      ...envArgs,
      SANDBOX_IMAGE,
      "sh", "-lc", command,
    ];

    log.info({ script: scriptPath, sessionId: ctx.sessionId }, "run_script starting");

    try {
      const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      });

      const output = [stdout, stderr].filter(Boolean).join("\n");
      return {
        success: true,
        output: output || "(no output)",
        metadata: { script: scriptPath, exitCode: 0, sandboxed: true },
      };
    } catch (err: unknown) {
      const e = err as { killed?: boolean; code?: number; stdout?: string; stderr?: string; message?: string };
      if (e.killed) {
        return { success: false, output: e.stdout ?? "", error: `Script timed out after ${EXEC_TIMEOUT_MS}ms` };
      }
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
      return {
        success: false,
        output,
        error: `Exit code ${e.code ?? "?"}: ${e.message ?? "Unknown error"}`,
        metadata: { script: scriptPath, sandboxed: true },
      };
    }
  },
});
