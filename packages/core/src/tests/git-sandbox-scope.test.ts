/**
 * Slice 0 of the containerized-agents design (design-tool-bridge D4 / §13): the git sandbox is
 * narrowed to the caller's own workspace root for every agent that is NOT full-scope, and fails
 * CLOSED when it cannot narrow. Before this, runGitInSandbox always bound the mount SOURCE — the
 * repo root in the compose deployment, which holds every account's workspace — at /workspace, so
 * a user-delegated git_developer (now in-process) or an unscoped orchestrator git call could run
 * git against the deployment's own repository, for any account.
 *
 * execFile is mocked so no docker runs; the assertions read the `-v` bind the runner passed and
 * the mountScope metadata it reported. workspace-mount is the REAL module, so the narrowing and
 * the named-volume fail-closed are exercised end to end.
 */
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.fn();

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  (execFile as unknown as Record<PropertyKey, unknown>)[promisify.custom] = execFileAsyncMock;
  return { execFile };
});

// The sandbox creates the caller's root and its state directory on the gateway side before a
// run. These are compose-layout paths, which on this machine are not the gateway's (on Windows
// "/workspace" is the root of the current drive), so nothing is created for them here.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const mkdirSync = ((path: Parameters<typeof real.mkdirSync>[0], options?: Parameters<typeof real.mkdirSync>[1]) =>
    /^\/workspace(\/|$)/.test(String(path).replace(/\\/g, "/")) ? undefined : real.mkdirSync(path, options)) as typeof real.mkdirSync;
  return { ...real, mkdirSync, default: { ...real, mkdirSync } };
});

// A per-user workspace path in the compose layout, and a host-path mount source for it.
const CALLER_WS = "/workspace/workspace/users/acct-1";
const HOST_SOURCE = "/opt/deploy/repo";

function bindArg(call: unknown[] | undefined): string {
  const args = (call?.[1] ?? []) as string[];
  return args[args.indexOf("-v") + 1] ?? "";
}

let savedMountSource: string | undefined;

describe("git sandbox scope narrowing (slice 0)", () => {
  beforeAll(async () => {
    await import("../tools/git.js");
  });

  beforeEach(() => {
    savedMountSource = process.env["SAI_WORKSPACE_MOUNT_SOURCE"];
  });

  afterEach(() => {
    if (savedMountSource === undefined) delete process.env["SAI_WORKSPACE_MOUNT_SOURCE"];
    else process.env["SAI_WORKSPACE_MOUNT_SOURCE"] = savedMountSource;
    execFileAsyncMock.mockReset();
    vi.restoreAllMocks();
  });

  it("binds the caller's OWN root for a generated-scope agent, not the repo", async () => {
    process.env["SAI_WORKSPACE_MOUNT_SOURCE"] = HOST_SOURCE;
    execFileAsyncMock.mockResolvedValue({ stdout: "## main", stderr: "" });
    const { getTool } = await import("../tools/registry.js");

    const result = await getTool("git_status")!.execute({}, {
      sessionId: "s-generated",
      workspacePath: CALLER_WS,
      workspaceScope: "generated",
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.["mountScope"]).toBe("caller");
    // The host offset UNDER the caller's workspace, bound at /workspace — never the bare repo root.
    expect(bindArg(execFileAsyncMock.mock.calls[0])).toBe(`${HOST_SOURCE}/workspace/users/acct-1:/workspace`);
    expect(bindArg(execFileAsyncMock.mock.calls[0])).not.toBe(`${HOST_SOURCE}:/workspace`);
  });

  it("narrows an UNDEFINED-scope caller too (an unscoped orchestrator git call)", async () => {
    process.env["SAI_WORKSPACE_MOUNT_SOURCE"] = HOST_SOURCE;
    execFileAsyncMock.mockResolvedValue({ stdout: "## main", stderr: "" });
    const { getTool } = await import("../tools/registry.js");

    const result = await getTool("git_status")!.execute({}, {
      sessionId: "s-undefined",
      workspacePath: CALLER_WS,
      // no workspaceScope
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.["mountScope"]).toBe("caller");
    expect(bindArg(execFileAsyncMock.mock.calls[0])).toBe(`${HOST_SOURCE}/workspace/users/acct-1:/workspace`);
  });

  it("keeps the whole-repo mount, read-only, for a full-scope agent (swarm_maintainer's git)", async () => {
    process.env["SAI_WORKSPACE_MOUNT_SOURCE"] = HOST_SOURCE;
    execFileAsyncMock.mockResolvedValue({ stdout: "## main", stderr: "" });
    const { getTool } = await import("../tools/registry.js");

    const result = await getTool("git_status")!.execute({}, {
      sessionId: "s-full",
      workspacePath: CALLER_WS,
      workspaceScope: "full",
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.["mountScope"]).toBe("repo");
    expect(bindArg(execFileAsyncMock.mock.calls[0])).toBe(`${HOST_SOURCE}:/workspace:ro`);
  });

  it("refuses WITHOUT spawning when a named-volume source cannot be narrowed", async () => {
    // No explicit host mount source -> resolveDockerWorkspaceMountSource falls back to the named
    // volume, which has no host path to subdivide. A non-full agent must not get the whole volume.
    delete process.env["SAI_WORKSPACE_MOUNT_SOURCE"];
    const { getTool } = await import("../tools/registry.js");

    const result = await getTool("git_status")!.execute({}, {
      sessionId: "s-volume",
      workspacePath: CALLER_WS,
      workspaceScope: "generated",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/named volume/i);
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });
});
