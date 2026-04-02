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
      "sh",
      "-lc",
      "git status --porcelain=v2 --branch",
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
    expect(execFileAsyncMock.mock.calls[0]?.[1]).toContain("git add src/tests");
    expect(execFileAsyncMock.mock.calls[1]?.[1]).toContain("git commit -m 'feat: add api tests'");
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
      "sh",
      "-lc",
      "git clone --branch main --depth 1 https://example.com/repo.git vendor/repo",
    ]), expect.any(Object));
  });
});