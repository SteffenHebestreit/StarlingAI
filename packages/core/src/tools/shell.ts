/**
 * Tier 2 shell execution tool — ALWAYS runs in Docker sandbox.
 * Never executes on the host machine directly.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { resolveDockerWorkspaceBind } from "./workspace-mount.js";
import { assertSafeDockerRunArgs } from "./docker-safety.js";
import { isSensitiveWorkspacePath } from "./filesystem.js";

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
    const sensitiveReference = findSensitiveWorkspaceReference(command);
    if (sensitiveReference) {
      return { success: false, output: "", error: `Command references protected workspace data: ${sensitiveReference}` };
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

    // The WORKSPACE at /workspace, not the deployment's mount source. See
    // resolveDockerWorkspaceBind: binding the source there made /workspace the repo, so this
    // sandbox's own contract ("paths are relative to /workspace") was false — and, now that
    // the workspace root is per-user, binding it is also what keeps one account's shell out of
    // another's files.
    const workspaceBind = resolveDockerWorkspaceBind(ctx.workspacePath, { at: "/workspace" });
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
      "-v", workspaceBind,
      "-w", workdir,
      ...envArgs,
      SANDBOX_IMAGE,
      "sh", "-lc", wrappedCommand,
    ];

    log.info({ command: command.substring(0, 200), sessionId: ctx.sessionId }, "shell_exec starting");

    try {
      assertSafeDockerRunArgs(dockerArgs, "shell");
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

/**
 * Shell commands bypass the filesystem-tool allowlist, so reject direct
 * references to repo secrets and VCS internals before a sandbox starts. This
 * complements the Docker mount policy and blocks obvious reads/copies/archives.
 *
 * Rather than hand-roll a second denylist (which drifts from the file tools and
 * mis-anchors on `./`, subdirs, and shell metacharacters), split the command
 * into path-like tokens and test each against the SAME isSensitiveWorkspacePath
 * the file tools use — so the two guards stay in sync and `.env.example` (the
 * public template that helper deliberately allows) is never falsely blocked.
 * It is still string-level, not a shell parser, so variable indirection
 * (`X=.env; cat $X`) or script *contents* are out of scope — the mount policy
 * is the deeper backstop. Returns the offending path, not a regex source.
 */
function findSensitiveWorkspaceReference(command: string): string | null {
  const tokens = command.split(/[\s'"=|;&<>()`]+/);
  for (const token of tokens) {
    if (isSensitiveCommandToken(token)) return normalizeCommandToken(token);
  }
  return null;
}

/** Strip a `/workspace/` prefix, `./` segments and leading slashes so the token
 *  becomes a workspace-relative path isSensitiveWorkspacePath can match. */
function normalizeCommandToken(token: string): string {
  return token
    .replace(/\\/g, "/")
    .replace(/^\/*workspace\//, "")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");
}

function isSensitiveCommandToken(token: string): boolean {
  const rel = normalizeCommandToken(token);
  return rel.length > 0 && isSensitiveWorkspacePath(rel);
}

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
    if (isSensitiveWorkspacePath(scriptPath)) {
      return { success: false, output: "", error: "Script path references protected workspace data" };
    }
    // Also reject protected paths passed as arguments (e.g. a generic `cat.sh`
    // invoked with `/workspace/.env`). Script *contents* can still reach any
    // mounted path — the mount policy is the deeper backstop there.
    const sensitiveArg = scriptArgs.map(normalizeCommandToken).find((arg) => arg.length > 0 && isSensitiveWorkspacePath(arg));
    if (sensitiveArg) {
      return { success: false, output: "", error: `Script argument references protected workspace data: ${sensitiveArg}` };
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

    const workspaceBind = resolveDockerWorkspaceBind(ctx.workspacePath, { at: "/workspace" });

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
      "-v", workspaceBind,
      "-w", "/workspace",
      ...envArgs,
      SANDBOX_IMAGE,
      "sh", "-lc", command,
    ];

    log.info({ script: scriptPath, sessionId: ctx.sessionId }, "run_script starting");

    try {
      assertSafeDockerRunArgs(dockerArgs, "shell");
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
