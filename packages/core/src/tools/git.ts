/**
 * Tier 2 / Tier 3 — Git version control tools.
 *
 * Read-only operations (git_status, git_log, git_diff) run without
 * per-call approval.  Mutating operations (git_commit, git_clone,
 * git_checkout) require per-call approval.
 *
 * All commands run inside the Docker sandbox with workspace mounted.
 * git_clone gets limited network access for fetching.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { resolveDockerWorkspaceMountSource } from "./workspace-mount.js";

const log = childLogger("tool:git");
const execFileAsync = promisify(execFile);

const SANDBOX_IMAGE = process.env["SAI_SANDBOX_IMAGE"] ?? "starlingai/sandbox:latest";
const EXEC_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

async function runGitInSandbox(
  args: string[],
  ctx: ToolContext,
  options?: { network?: boolean; workdir?: string },
): Promise<{ success: boolean; output: string; error?: string }> {
  const workspaceMountSource = resolveDockerWorkspaceMountSource(ctx.workspacePath);
  const workdir = options?.workdir ?? "/workspace";
  const gitCmd = ["git", ...args].join(" ");

  const dockerArgs = [
    "run", "--rm",
    options?.network ? "--network=bridge" : "--network=none",
    "--memory=512m",
    "--cpus=0.5",
    "--pids-limit=64",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "-v", `${workspaceMountSource}:/workspace`,
    "-w", workdir,
    SANDBOX_IMAGE,
    "sh", "-lc", gitCmd,
  ];

  try {
    const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { success: true, output: [stdout, stderr].filter(Boolean).join("\n") || "(no output)" };
  } catch (err: unknown) {
    const e = err as { killed?: boolean; code?: number; stdout?: string; stderr?: string; message?: string };
    if (e.killed) {
      return { success: false, output: e.stdout ?? "", error: `Git command timed out after ${EXEC_TIMEOUT_MS}ms` };
    }
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return { success: false, output, error: `Exit code ${e.code ?? "?"}: ${e.message?.split("\n")[0] ?? "Unknown error"}` };
  }
}

// ── git_status (Tier 0 — read-only) ─────────────────────────────────────

registerTool({
  name: "git_status",
  description: "Show the working tree status of a git repository in the workspace. Returns modified, staged, and untracked files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Subdirectory within /workspace to check (default: repository root).",
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const subdir = String(args["path"] ?? "");
    const workdir = subdir ? `/workspace/${subdir.replace(/\\/g, "/")}` : "/workspace";
    log.info({ workdir, sessionId: ctx.sessionId }, "git_status");
    return runGitInSandbox(["status", "--porcelain=v2", "--branch"], ctx, { workdir });
  },
});

// ── git_log (Tier 0 — read-only) ────────────────────────────────────────

registerTool({
  name: "git_log",
  description: "Show commit history. Returns recent commits with hash, author, date, and message.",
  parameters: {
    type: "object",
    properties: {
      count: {
        type: "number",
        description: "Number of commits to show (default: 20, max: 100).",
        default: 20,
      },
      path: {
        type: "string",
        description: "Subdirectory or file path to filter history.",
      },
      oneline: {
        type: "boolean",
        description: "Use condensed one-line format (default: false).",
        default: false,
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const count = Math.min(Math.max(Number(args["count"] ?? 20), 1), 100);
    const filePath = args["path"] ? String(args["path"]) : undefined;
    const oneline = Boolean(args["oneline"]);

    const gitArgs = ["log", `--max-count=${count}`];
    if (oneline) {
      gitArgs.push("--oneline");
    } else {
      gitArgs.push("--format=%H %an <%ae> %ai%n  %s%n");
    }
    if (filePath) gitArgs.push("--", filePath);

    log.info({ count, filePath, sessionId: ctx.sessionId }, "git_log");
    return runGitInSandbox(gitArgs, ctx);
  },
});

// ── git_diff (Tier 0 — read-only) ───────────────────────────────────────

registerTool({
  name: "git_diff",
  description: "Show file differences. Without arguments shows unstaged changes. Use 'staged: true' for staged changes, or provide two refs to compare.",
  parameters: {
    type: "object",
    properties: {
      staged: {
        type: "boolean",
        description: "Show staged (cached) changes instead of working tree (default: false).",
      },
      ref1: {
        type: "string",
        description: "First commit/branch ref for comparison (e.g. 'HEAD~3', 'main').",
      },
      ref2: {
        type: "string",
        description: "Second commit/branch ref (default: working tree or HEAD).",
      },
      path: {
        type: "string",
        description: "Restrict diff to a specific file or directory.",
      },
      stat: {
        type: "boolean",
        description: "Show diffstat summary only (no content). Default: false.",
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gitArgs = ["diff"];
    if (args["staged"]) gitArgs.push("--cached");
    if (args["stat"]) gitArgs.push("--stat");
    if (args["ref1"]) {
      gitArgs.push(String(args["ref1"]));
      if (args["ref2"]) gitArgs.push(String(args["ref2"]));
    }
    if (args["path"]) gitArgs.push("--", String(args["path"]));

    log.info({ sessionId: ctx.sessionId }, "git_diff");
    return runGitInSandbox(gitArgs, ctx);
  },
});

// ── git_commit (Tier 2 — mutating, per-call approval) ───────────────────

registerTool({
  name: "git_commit",
  description: "Stage files and create a git commit. Provide file patterns to stage (or '.' for all changes) and a commit message.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Commit message.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Files or patterns to stage before committing (e.g., ['.'] for all, ['src/', 'README.md']).",
        default: ["."],
      },
      author: {
        type: "string",
        description: "Author override in 'Name <email>' format. Defaults to git config.",
      },
    },
    required: ["message"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const message = String(args["message"] ?? "");
    const files = (Array.isArray(args["files"]) ? args["files"] : ["."]).map(String);
    const author = args["author"] ? String(args["author"]) : undefined;

    if (!message.trim()) {
      return { success: false, output: "", error: "Commit message cannot be empty" };
    }

    // Stage files first
    const addResult = await runGitInSandbox(["add", ...files], ctx);
    if (!addResult.success) return addResult;

    // Commit
    const commitArgs = ["commit", "-m", `'${message.replace(/'/g, "'\\''")}'`];
    if (author) commitArgs.push("--author", `'${author.replace(/'/g, "'\\''")}'`);

    log.info({ message: message.substring(0, 100), files, sessionId: ctx.sessionId }, "git_commit");
    return runGitInSandbox(commitArgs, ctx);
  },
});

// ── git_clone (Tier 3 — privileged, needs network) ──────────────────────

registerTool({
  name: "git_clone",
  description: "Clone a git repository into the workspace. Requires network access. Use for fetching external code repositories.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Repository URL (https:// or git://).",
      },
      destination: {
        type: "string",
        description: "Target directory name within /workspace.",
      },
      branch: {
        type: "string",
        description: "Specific branch to clone.",
      },
      depth: {
        type: "number",
        description: "Shallow clone depth (e.g. 1 for latest commit only).",
      },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = String(args["url"] ?? "");
    const destination = args["destination"] ? String(args["destination"]) : undefined;
    const branch = args["branch"] ? String(args["branch"]) : undefined;
    const depth = args["depth"] ? Number(args["depth"]) : undefined;

    // Only allow https:// URLs for safety
    if (!/^https:\/\//i.test(url)) {
      return { success: false, output: "", error: "Only https:// repository URLs are allowed" };
    }

    const gitArgs = ["clone"];
    if (branch) gitArgs.push("--branch", branch);
    if (depth && depth > 0) gitArgs.push("--depth", String(Math.floor(depth)));
    gitArgs.push(url);
    if (destination) gitArgs.push(destination);

    log.info({ url, destination, branch, depth, sessionId: ctx.sessionId }, "git_clone");
    return runGitInSandbox(gitArgs, ctx, { network: true });
  },
});

// ── git_checkout (Tier 2 — mutating, per-call approval) ─────────────────

registerTool({
  name: "git_checkout",
  description: "Switch branches or restore working tree files. Use to switch to an existing branch, create a new branch, or restore files.",
  parameters: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        description: "Branch name, tag, or commit hash to check out.",
      },
      createBranch: {
        type: "boolean",
        description: "Create a new branch with the given name (default: false).",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Specific files to restore (checkout from HEAD).",
      },
    },
    required: ["ref"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ref = String(args["ref"] ?? "");
    const createBranch = Boolean(args["createBranch"]);
    const files = Array.isArray(args["files"]) ? args["files"].map(String) : undefined;

    if (!ref.trim()) {
      return { success: false, output: "", error: "ref is required" };
    }

    const gitArgs = ["checkout"];
    if (createBranch) gitArgs.push("-b");
    gitArgs.push(ref);
    if (files?.length) gitArgs.push("--", ...files);

    log.info({ ref, createBranch, sessionId: ctx.sessionId }, "git_checkout");
    return runGitInSandbox(gitArgs, ctx);
  },
});
