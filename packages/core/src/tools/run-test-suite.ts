/**
 * Tier 2 (execute, per-call approval) — Run a named test suite in the Docker sandbox.
 *
 * Maps a logical test-suite name to a configured command (pnpm test, pytest,
 * make test, etc.) and executes it in the isolated sandbox container with the
 * workspace mounted.  Agents can discover suite names via workspace_search
 * or list_files rather than hard-coding commands.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { resolveDockerWorkspaceMountSource } from "./workspace-mount.js";
import { assertSafeDockerRunArgs } from "./docker-safety.js";

const log = childLogger("tool:run-test-suite");
const execFileAsync = promisify(execFile);

const SANDBOX_IMAGE = process.env["SAI_SANDBOX_IMAGE"] ?? "starlingai/sandbox:latest";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

/** Well-known test runner detection patterns mapped to commands. */
const KNOWN_RUNNERS: Record<string, string> = {
  vitest: "pnpm vitest run",
  jest: "pnpm jest --no-coverage",
  pytest: "pytest -v",
  mocha: "pnpm mocha",
  go: "go test ./...",
  cargo: "cargo test",
  make: "make test",
  npm: "npm test",
};

registerTool({
  name: "run_test_suite",
  description:
    "Run a named test suite in the Docker sandbox and return the full output. " +
    "Supports vitest, jest, pytest, mocha, go test, cargo test, or a custom shell command. " +
    "Use suite='vitest', 'jest', 'pytest', etc. for well-known runners, or provide a " +
    "custom `command` to run any other test invocation. " +
    "Requires per-call approval because it executes code.",
  parameters: {
    type: "object",
    properties: {
      suite: {
        type: "string",
        description:
          "Test runner or suite name: vitest, jest, pytest, mocha, go, cargo, make, npm, or 'custom'.",
        enum: ["vitest", "jest", "pytest", "mocha", "go", "cargo", "make", "npm", "custom"],
      },
      command: {
        type: "string",
        description:
          "Custom test command to run. Required when suite='custom', ignored otherwise.",
      },
      filter: {
        type: "string",
        description:
          "Optional test name filter / pattern passed to the runner (e.g. a test file path or describe name).",
      },
      workdir: {
        type: "string",
        description: "Subdirectory inside /workspace to run tests from (default: /workspace).",
        default: "/workspace",
      },
      timeoutMs: {
        type: "number",
        description:
          "Maximum time in milliseconds to wait for the suite to finish (default: 120000, max: 600000).",
        default: 120000,
      },
    },
    required: ["suite"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const suite = String(args["suite"] ?? "custom");
    const customCommand = args["command"] != null ? String(args["command"]).trim() : "";
    const filter = args["filter"] != null ? String(args["filter"]).trim() : "";
    const rawWorkdir = String(args["workdir"] ?? "/workspace").trim().replace(/\\/g, "/");
    const timeoutMs = Math.min(
      Math.max(Number(args["timeoutMs"] ?? DEFAULT_TIMEOUT_MS), 5_000),
      MAX_TIMEOUT_MS,
    );

    // Resolve command — validate suite at runtime so an off-list value cannot
    // reach the shell-interpolated fallback path.
    const knownSuites = Object.keys(KNOWN_RUNNERS);
    let baseCommand: string;
    if (suite === "custom") {
      if (!customCommand) {
        return { success: false, output: "", error: "command is required when suite='custom'" };
      }
      baseCommand = customCommand;
    } else if (knownSuites.includes(suite)) {
      baseCommand = KNOWN_RUNNERS[suite]!;
    } else {
      return {
        success: false,
        output: "",
        error: `Unknown suite '${suite}'. Allowed: ${knownSuites.join(", ")}, custom.`,
      };
    }

    // Append filter if provided (most runners accept a positional pattern).
    // Single-quote-wrap so multi-word patterns reach the runner as one argv element.
    const fullCommand = filter
      ? `${baseCommand} '${filter.replace(/'/g, "'\"'\"'")}'`
      : baseCommand;

    // Constrain workdir to /workspace
    const workdir =
      rawWorkdir.startsWith("/workspace") && !rawWorkdir.includes("..")
        ? rawWorkdir
        : "/workspace";

    const workspaceMountSource = resolveDockerWorkspaceMountSource(ctx.workspacePath);

    const dockerArgs = [
      "run", "--rm",
      "--network=none",
      "--memory=1g",
      "--cpus=1.0",
      "--pids-limit=128",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "-v", `${workspaceMountSource}:/workspace`,
      "-w", workdir,
      SANDBOX_IMAGE,
      "sh", "-lc", fullCommand,
    ];

    log.info({ suite, command: fullCommand, workdir, sessionId: ctx.sessionId }, "run_test_suite starting");

    try {
      assertSafeDockerRunArgs(dockerArgs, "run_test_suite");
      const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
      return {
        success: true,
        output,
        metadata: { suite, command: fullCommand, workdir, sandboxed: true },
      };
    } catch (err: unknown) {
      const e = err as {
        killed?: boolean;
        code?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      if (e.killed) {
        return {
          success: false,
          output: e.stdout ?? "",
          error: `Test suite timed out after ${timeoutMs}ms`,
          metadata: { sandboxed: true },
        };
      }
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
      // Non-zero exit from the test runner is a test-failure, not a tool-failure
      return {
        success: true,
        output: output || "(no output)",
        metadata: {
          suite,
          command: fullCommand,
          exitCode: e.code ?? 1,
          sandboxed: true,
          testsFailed: true,
        },
      };
    }
  },
});
