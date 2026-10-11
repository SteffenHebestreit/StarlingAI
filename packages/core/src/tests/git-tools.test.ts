import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.fn();

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  (execFile as unknown as Record<PropertyKey, unknown>)[promisify.custom] = execFileAsyncMock;
  return { execFile };
});

vi.mock("../tools/workspace-mount.js", () => ({
  resolveDockerWorkspaceMountSource: vi.fn((workspacePath: string) => workspacePath),
  // git.ts now narrows the sandbox per caller via resolveDockerWorkspaceBind. For these tests the
  // workspace path is a bare host path (not under /workspace), where the real helper returns
  // `<path>:<at>` — mirror that so the -v spec these assertions expect is unchanged.
  resolveDockerWorkspaceBind: vi.fn((workspacePath: string, options?: { at?: string }) => `${workspacePath}:${options?.at ?? workspacePath}`),
  // The isolation flags have their own tests (sandbox-isolation); none here keeps these vectors as written.
  sandboxIsolationArgs: vi.fn(() => []),
  sandboxBindSpec: vi.fn((bindSpec: string) => bindSpec),
  // So does the path mapping (sandbox-owner-and-path); it leaves the relative paths here as written.
  toSandboxPath: vi.fn((path: string) => path),
}));

describe("git tools", () => {
  beforeAll(async () => {
    await import("../tools/git.js");
  });

  afterEach(() => {
    execFileAsyncMock.mockReset();
    vi.restoreAllMocks();
  });

  it("runs git_status in the sandbox with read-only network settings", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "## main\n1 .M N... 100644 100644 100644 abc abc file.ts\n", stderr: "" });

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("git_status");

    const result = await tool!.execute({ path: "packages/core" }, {
      sessionId: "session-git-status",
      workspacePath: "F:/StarlingAI",
    });

    expect(result.success).toBe(true);
    expect(execFileAsyncMock).toHaveBeenCalledWith("docker", expect.arrayContaining([
      "run",
      "--rm",
      "--network=none",
      "-v",
      "F:/StarlingAI:/workspace",
      "-w",
      "/workspace/packages/core",
      "git",
      "status",
      "--porcelain=v2",
      "--branch",
    ]), expect.objectContaining({ timeout: 60000 }));
  });

  it("stages files and commits with git_commit", async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "[main abc123] feat: add api tests\n 1 file changed\n", stderr: "" });

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("git_commit");

    const result = await tool!.execute({
      message: "feat: add api tests",
      files: ["src/tests"],
    }, {
      sessionId: "session-git-commit",
      workspacePath: "F:/StarlingAI",
    });

    expect(result.success).toBe(true);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
    const addCallArgs = execFileAsyncMock.mock.calls[0]?.[1] as string[];
    const commitCallArgs = execFileAsyncMock.mock.calls[1]?.[1] as string[];
    expect(addCallArgs).toEqual(expect.arrayContaining(["git", "add", "--", "src/tests"]));
    expect(commitCallArgs).toEqual(expect.arrayContaining(["git", "commit", "-m", "feat: add api tests"]));
  });

  it("rejects non-https clone URLs", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("git_clone");

    const result = await tool!.execute({
      url: "git://example.com/repo.git",
    }, {
      sessionId: "session-git-clone-invalid",
      workspacePath: "F:/StarlingAI",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Only https:\/\/ repository URLs/i);
  });

  it("enables bridge networking for git_clone", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "Cloning into 'repo'...", stderr: "" });

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("git_clone");

    const result = await tool!.execute({
      url: "https://example.com/repo.git",
      destination: "vendor/repo",
      branch: "main",
      depth: 1,
    }, {
      sessionId: "session-git-clone",
      workspacePath: "F:/StarlingAI",
    });

    expect(result.success).toBe(true);
    expect(execFileAsyncMock).toHaveBeenCalledWith("docker", expect.arrayContaining([
      "--network=bridge",
      "git",
      "clone",
      "--branch",
      "main",
      "--depth",
      "1",
      "https://example.com/repo.git",
      "vendor/repo",
    ]), expect.any(Object));
  });
});

/**
 * NO GIT TOOL PRINTS AN UNTRACKED OR IGNORED FILE (review 2026-10-12). The full-scope repo bind keeps
 * the gateway's state readable under a case alias on Docker Desktop, which is acceptable only while
 * git, run with the arguments its tool fixes, prints nothing but tracked content. A value the model
 * supplies that git reads as an option broke that: `--no-index` (or two refs naming paths outside the
 * repository) made git_diff print any file, and `--receive-pack` on a push to a local path ran a
 * command through a shell.
 */
describe("git tools: what the model supplies is never a git option", () => {
  const ctx = { sessionId: "session-git-options", workspacePath: "F:/StarlingAI", workspaceScope: "full" as const };
  const gitArgv = () => {
    const args = (execFileAsyncMock.mock.calls.at(-1)?.[1] ?? []) as string[];
    return args.slice(args.indexOf("git") + 1);
  };

  afterEach(() => {
    execFileAsyncMock.mockReset();
  });

  it.each([
    ["git_diff", { ref1: "--no-index", ref2: "/dev/null" }],
    ["git_diff", { ref1: "HEAD", ref2: "--output=/workspace/workspace/agents/x.jsonc" }],
    ["git_checkout", { ref: "--orphan" }],
    ["git_tag", { name: "--list" }],
    ["git_tag", { name: "v1", ref: "--contains" }],
    ["git_push", { remote: "-v" }],
    ["git_push", { remote: ".", branch: "--receive-pack=cat /workspace/.STARLINGAI/credentials.enc >&2; false" }],
    ["git_clone", { url: "https://example.com/repo.git", destination: "--config=core.fsmonitor=cat /etc/passwd" }],
  ] as const)("%s refuses %j and runs nothing", async (tool, args) => {
    const { getTool } = await import("../tools/registry.js");
    const result = await getTool(tool)!.execute({ ...args }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/would be read as a git option/);
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it("git_diff closes its refs with --, so two paths are refs to git and never a no-index diff", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
    const { getTool } = await import("../tools/registry.js");
    await getTool("git_diff")!.execute({ ref1: "/dev/null", ref2: "/workspace/.STARLINGAI/accounts.json" }, ctx);
    expect(gitArgv()).toEqual(["diff", "/dev/null", "/workspace/.STARLINGAI/accounts.json", "--"]);
    await getTool("git_diff")!.execute({ ref1: "HEAD~1", path: "agents" }, ctx);
    expect(gitArgv()).toEqual(["diff", "HEAD~1", "--", "agents"]);
    await getTool("git_diff")!.execute({ staged: true, stat: true }, ctx);
    expect(gitArgv()).toEqual(["diff", "--cached", "--stat", "--"]);
  });

  it("git_clone puts its URL and destination after --", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
    const { getTool } = await import("../tools/registry.js");
    await getTool("git_clone")!.execute({ url: "https://example.com/repo.git", destination: "vendor/repo" }, ctx);
    expect(gitArgv()).toEqual(["clone", "--", "https://example.com/repo.git", "vendor/repo"]);
  });
});