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
import { resolveDockerWorkspaceBind, resolveDockerWorkspaceMountSource, sandboxBindSpec, sandboxIsolationArgs, toSandboxPath } from "./workspace-mount.js";
import { assertSafeDockerRunArgs } from "./docker-safety.js";

const log = childLogger("tool:git");
const execFileAsync = promisify(execFile);

const SANDBOX_IMAGE = process.env["SAI_SANDBOX_IMAGE"] ?? "starlingai/sandbox:latest";
const EXEC_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

async function runGitInSandbox(
  args: string[],
  ctx: ToolContext,
  options?: { network?: boolean; workdir?: string },
): Promise<{ success: boolean; output: string; error?: string; metadata?: Record<string, unknown> }> {
  const workdir = options?.workdir ?? "/workspace";

  // THE GIT SANDBOX IS NARROWED TO THE CALLER, EXCEPT FOR THE FULL-SCOPE MAINTENANCE AGENT.
  // These tools run git against the mount, and in the shipped compose deployment the mount source
  // is the REPO ROOT — which holds every account's workspace. A "full" agent (swarm_maintainer)
  // maintains the deployment itself, so it keeps the whole-repo mount: git over the shared tree is
  // its job. Every other caller runs "generated" scope (git_developer and diff_reviewer) or no
  // scope at all (an unscoped orchestrator git call), and gets the SAME per-caller bind the shell
  // sandbox already uses (resolveDockerWorkspaceBind with `at: "/workspace"`), so a user-delegated
  // git agent cannot reach the deployment repo or another account's workspace. When the mount
  // source is a named volume there is no host path to subdivide, so the narrow fails CLOSED
  // (requireNarrow → null) rather than silently falling back to the whole tree.
  //
  // The full-scope repo bind is read-only but for the config zones and generated/, and the gateway's
  // state in it (the repo root's and the shared root's state directories, users/) stays READABLE
  // there under a case alias on Docker Desktop, where the tmpfs masks hold one spelling only. The
  // shell gets no such bind for that reason (workspace-mount.ts fullScopeZoneMounts). This one is
  // acceptable because nothing but git runs in it: no shell, arguments this module fixes, and every
  // value the model supplies is an option's value, a pathspec after `--`, or refused where git would
  // read it as an option (refuseOptionLike). git prints file content only from its object database
  // and index, never an untracked or ignored file; the one way it does, a no-index diff (`--no-index`,
  // or two refs that name paths outside the repository), git_diff closes off. Nor does git run a
  // command a repository's own config or hooks name: the write tools refuse `.git` by name, and
  // safe.bareRepository below keeps git from taking a directory merely shaped like one.
  let bind: string;
  let mountScope: "caller" | "repo";
  if (ctx.workspaceScope === "full") {
    bind = `${resolveDockerWorkspaceMountSource(ctx.workspacePath)}:/workspace`;
    mountScope = "repo";
  } else {
    const narrowed = resolveDockerWorkspaceBind(ctx.workspacePath, { at: "/workspace", requireNarrow: true });
    if (narrowed === null) {
      return {
        success: false,
        output: "",
        error: "Git sandbox refused: the workspace mount source is a named volume that cannot be narrowed to this agent's own root, and the agent is not full-scope. Nothing was run.",
        metadata: { mountScope: "caller" },
      };
    }
    bind = narrowed;
    mountScope = "caller";
  }

  // Invoke git directly inside the container (no `sh -lc`) so caller-supplied
  // strings cannot be interpreted as shell metacharacters.
  const dockerArgs = [
    "run", "--rm",
    options?.network ? "--network=bridge" : "--network=none",
    "--memory=512m",
    "--cpus=0.5",
    "--pids-limit=64",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "-v", sandboxBindSpec(bind, { workspacePath: ctx.workspacePath, workspaceScope: ctx.workspaceScope, bind: mountScope }),
    // As the owner of the directory bound at /workspace, which git also requires before it reads
    // a repository at all, with the gateway's state in the bind masked. The full-scope repo bind is
    // read-only but for the config zones and generated/ (sandboxIsolationArgs).
    ...sandboxIsolationArgs({ workspacePath: ctx.workspacePath, workspaceScope: ctx.workspaceScope, bind: mountScope }),
    // Where the sandbox does not run as that owner (no --user on a Windows-native gateway, or an
    // owner the stat could not read), git refuses a repository as of "dubious ownership".
    // safe.directory lifts that for this run only, through the environment, which is the command
    // scope: git honours safe.directory only from protected configuration. `*`, not /workspace:
    // git matches the value against the repository's own directory, so /workspace left a repository
    // in a subdirectory (generated/<clone>) refused. The ownership check protects nothing here: the
    // sandbox sees only the bind this tool hands the caller (its own root, or the full-scope repo
    // bind), where every file is the bind owner's, or shows as root's on Docker Desktop, and no
    // other user's repository is there to be kept from.
    // safe.bareRepository=explicit: git takes no directory it discovers for a bare repository. The
    // write tools refuse `.git` by name (filesystem.ts), but they can still make a directory shaped
    // like one (HEAD, objects/, refs/, and a config with core.worktree and core.fsmonitor), and
    // git_status with that as its path ran the config's command (probed against starlingai/sandbox,
    // git 2.43). No git tool works on a bare repository.
    "-e", "GIT_CONFIG_COUNT=2",
    "-e", "GIT_CONFIG_KEY_0=safe.directory",
    "-e", "GIT_CONFIG_VALUE_0=*",
    "-e", "GIT_CONFIG_KEY_1=safe.bareRepository",
    "-e", "GIT_CONFIG_VALUE_1=explicit",
    "-w", workdir,
    SANDBOX_IMAGE,
    "git", ...args,
  ];

  try {
    assertSafeDockerRunArgs(dockerArgs, "git");
    const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { success: true, output: [stdout, stderr].filter(Boolean).join("\n") || "(no output)", metadata: { mountScope } };
  } catch (err: unknown) {
    const e = err as { killed?: boolean; code?: number; stdout?: string; stderr?: string; message?: string };
    if (e.killed) {
      return { success: false, output: e.stdout ?? "", error: `Git command timed out after ${EXEC_TIMEOUT_MS}ms`, metadata: { mountScope } };
    }
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return { success: false, output, error: `Exit code ${e.code ?? "?"}: ${e.message?.split("\n")[0] ?? "Unknown error"}`, metadata: { mountScope } };
  }
}

/**
 * A path the model supplied, where the sandbox sees it. A sandbox narrowed to the caller has the
 * caller's root at /workspace, so the gateway path every sub-agent is told maps there, as it does for
 * shell_exec; a relative path stays relative. The full-scope repo bind needs nothing: its gateway
 * path under /workspace already is the sandbox path.
 */
function sandboxPathFor(path: string, ctx: ToolContext): string {
  return ctx.workspaceScope === "full" ? path : toSandboxPath(path, ctx.workspacePath);
}

/**
 * The refusal for a value the model supplied that git would parse as an option where the tool puts
 * it: a ref, a tag or branch name, a remote, a clone destination. No ref, branch, tag or remote name
 * can start with "-" (git check-ref-format), so nothing real is refused. Taken as an option, such a
 * value changed what git does: `--no-index` turned git_diff into a diff of any two files, the
 * gateway's state under a case alias included (workspace-mount.ts), `--output=<file>` wrote one, and
 * `--receive-pack=<command>` on a push to a local path ran a command through a shell.
 */
function refuseOptionLike(fields: Record<string, string | undefined>): ToolResult | null {
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined && value.trimStart().startsWith("-")) {
      return { success: false, output: "", error: `Invalid ${field} "${value}": it would be read as a git option. Nothing was run.` };
    }
  }
  return null;
}

// ── git_status (Tier 0 — read-only)─────────────────────────────────────

registerTool({
  name: "git_status",
  description: "Show the working tree status of a git repository in the workspace. Returns modified, staged, and untracked files.",
  embeddingDescription: "Check, show git status, working tree changes, modified files, staged files. Git-Status prüfen, Änderungen anzeigen, was hat sich geändert.",
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
    const mapped = sandboxPathFor(subdir, ctx);
    const workdir = mapped !== subdir ? mapped : subdir ? `/workspace/${subdir.replace(/\\/g, "/")}` : "/workspace";
    log.info({ workdir, sessionId: ctx.sessionId }, "git_status");
    return runGitInSandbox(["status", "--porcelain=v2", "--branch"], ctx, { workdir });
  },
});

// ── git_log (Tier 0 — read-only) ────────────────────────────────────────

registerTool({
  name: "git_log",
  description: "Show commit history. Returns recent commits with hash, author, date, and message.",
  embeddingDescription: "Show, view git commit history, log, recent commits. Git-Historie anzeigen, Commit-Verlauf, letzte Commits auflisten.",
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
    const filePath = args["path"] ? sandboxPathFor(String(args["path"]), ctx) : undefined;
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
  embeddingDescription: "Show, view git diff, file differences, changes between commits or branches. Git-Diff anzeigen, Dateiänderungen, Unterschiede zwischen Commits.",
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
    const ref1 = args["ref1"] ? String(args["ref1"]) : undefined;
    const ref2 = ref1 && args["ref2"] ? String(args["ref2"]) : undefined;
    const refused = refuseOptionLike({ ref1, ref2 });
    if (refused) return refused;
    const gitArgs = ["diff"];
    if (args["staged"]) gitArgs.push("--cached");
    if (args["stat"]) gitArgs.push("--stat");
    // Each ref peeled to the commit it names. Where the working directory is no repository (an
    // auth-off session's shared-root bind, a full-scope repo bind without .git), git took two
    // arguments for paths and diffed them with no index whatever followed (diff_no_index drops the
    // `--`), which printed any file the sandbox can read. `<ref>^{commit}` resolves for every ref,
    // range and commit a caller means, and names no file git or the gateway keeps, so outside a
    // repository it is an error, not a diff of two files.
    if (ref1) gitArgs.push(`${ref1}^{commit}`);
    if (ref2) gitArgs.push(`${ref2}^{commit}`);
    // `--` closes the refs, always: inside a repository two arguments with none after them, where one
    // names a path outside it (`/dev/null` and a file), are a no-index diff to git too.
    gitArgs.push("--");
    if (args["path"]) gitArgs.push(sandboxPathFor(String(args["path"]), ctx));

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
    const files = (Array.isArray(args["files"]) ? args["files"] : ["."]).map((file) => sandboxPathFor(String(file), ctx));
    const author = args["author"] ? String(args["author"]) : undefined;

    if (!message.trim()) {
      return { success: false, output: "", error: "Commit message cannot be empty" };
    }

    // Stage files first
    const addResult = await runGitInSandbox(["add", "--", ...files], ctx);
    if (!addResult.success) return addResult;

    // Commit — no shell quoting needed; git is invoked directly via execve.
    const commitArgs = ["commit", "-m", message];
    if (author) commitArgs.push("--author", author);

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
    const destination = args["destination"] ? sandboxPathFor(String(args["destination"]), ctx) : undefined;
    const branch = args["branch"] ? String(args["branch"]) : undefined;
    const depth = args["depth"] ? Number(args["depth"]) : undefined;

    // Only allow https:// URLs for safety
    if (!/^https:\/\//i.test(url)) {
      return { success: false, output: "", error: "Only https:// repository URLs are allowed" };
    }

    const refused = refuseOptionLike({ destination });
    if (refused) return refused;

    const gitArgs = ["clone"];
    if (branch) gitArgs.push("--branch", branch);
    if (depth && depth > 0) gitArgs.push("--depth", String(Math.floor(depth)));
    gitArgs.push("--", url);
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
    const files = Array.isArray(args["files"]) ? args["files"].map((file) => sandboxPathFor(String(file), ctx)) : undefined;

    if (!ref.trim()) {
      return { success: false, output: "", error: "ref is required" };
    }
    const refused = refuseOptionLike({ ref });
    if (refused) return refused;

    const gitArgs = ["checkout"];
    if (createBranch) gitArgs.push("-b");
    gitArgs.push(ref);
    if (files?.length) gitArgs.push("--", ...files);

    log.info({ ref, createBranch, sessionId: ctx.sessionId }, "git_checkout");
    return runGitInSandbox(gitArgs, ctx);
  },
});

// ── git_tag (Tier 2 — mutating, per-call approval) ───────────────────────

registerTool({
  name: "git_tag",
  description:
    "Create an annotated or lightweight Git tag on the current HEAD or a specific commit. " +
    "Annotated tags (default) include a message and the tagger identity. " +
    "Use lightweight tags only when the tag is a temporary bookmark.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Tag name (e.g. v1.2.3).",
      },
      message: {
        type: "string",
        description:
          "Annotation message for the tag. When provided, creates an annotated tag. " +
          "Omit to create a lightweight tag.",
      },
      ref: {
        type: "string",
        description: "Commit hash, branch, or ref to tag (default: HEAD).",
      },
      force: {
        type: "boolean",
        description: "Replace an existing tag with the same name (default: false).",
      },
    },
    required: ["name"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = String(args["name"] ?? "").trim();
    const message = args["message"] != null ? String(args["message"]).trim() : "";
    const ref = args["ref"] != null ? String(args["ref"]).trim() : "";
    const force = Boolean(args["force"]);

    if (!name || !/^[a-zA-Z0-9._/-]+$/.test(name)) {
      return { success: false, output: "", error: "Invalid tag name." };
    }
    const refused = refuseOptionLike({ name, ref: ref || undefined });
    if (refused) return refused;

    const gitArgs = ["tag"];
    if (force) gitArgs.push("-f");
    if (message) {
      gitArgs.push("-a", name, "-m", message);
    } else {
      gitArgs.push(name);
    }
    if (ref) gitArgs.push(ref);

    log.info({ name, message: !!message, ref, force, sessionId: ctx.sessionId }, "git_tag");
    return runGitInSandbox(gitArgs, ctx);
  },
});

// ── git_push (Tier 2 — mutating + network, per-call approval) ───────────

registerTool({
  name: "git_push",
  description:
    "Push local commits or tags to a remote Git repository. " +
    "Network access is enabled for the sandbox during this operation. " +
    "Requires per-call approval because it communicates with an external remote.",
  parameters: {
    type: "object",
    properties: {
      remote: {
        type: "string",
        description: "Remote name (default: origin).",
        default: "origin",
      },
      branch: {
        type: "string",
        description: "Local branch to push (default: current branch).",
      },
      tags: {
        type: "boolean",
        description: "Push all tags alongside the branch (default: false).",
      },
      force: {
        type: "boolean",
        description: "Force-push — only use when rewriting history is intentional (default: false).",
      },
      setUpstream: {
        type: "boolean",
        description: "Set the upstream tracking reference for the branch (default: false).",
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const remote = String(args["remote"] ?? "origin").trim() || "origin";
    const branch = args["branch"] != null ? String(args["branch"]).trim() : "";
    const tags = Boolean(args["tags"]);
    const force = Boolean(args["force"]);
    const setUpstream = Boolean(args["setUpstream"]);

    // Validate remote name
    if (!/^[a-zA-Z0-9_.-]+$/.test(remote)) {
      return { success: false, output: "", error: "Invalid remote name." };
    }
    const refused = refuseOptionLike({ remote, branch: branch || undefined });
    if (refused) return refused;

    const gitArgs = ["push"];
    if (force) gitArgs.push("--force");
    if (setUpstream) gitArgs.push("--set-upstream");
    if (tags) gitArgs.push("--tags");
    gitArgs.push(remote);
    if (branch) gitArgs.push(branch);

    log.info({ remote, branch, tags, force, sessionId: ctx.sessionId }, "git_push");
    return runGitInSandbox(gitArgs, ctx, { network: true });
  },
});

