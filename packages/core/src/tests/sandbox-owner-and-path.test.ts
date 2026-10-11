/**
 * THE SANDBOX RUNS AS THE WORKSPACE'S OWNER, AND THE GATEWAY'S PATH TO IT IS /workspace INSIDE
 * (E2E 2026-10-11).
 *
 * Two failures stopped every in-process shell, git and test agent before its command ran:
 *   - the sandbox image's own user (uid 1000) owns nothing in a workspace the gateway created as
 *     root, so `mkdir -p generated/...` and `git init` failed with "Permission denied";
 *   - sub-agents are told "Current workspace: <gateway path>" and passed that path back as the
 *     workdir (or `cd`'d into it), but the sandbox has the directory at /workspace only.
 *
 * execFile is mocked, so no docker runs: the assertions read the argument vector each tool passed.
 * workspace-mount is the REAL module, and the workspace is a real temporary directory, so the
 * owner comes from an actual stat.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/registry.js";

const execFileAsyncMock = vi.fn();

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  (execFile as unknown as Record<PropertyKey, unknown>)[promisify.custom] = execFileAsyncMock;
  return { execFile };
});

const ACCOUNT_ROOT = "/workspace/workspace/users/acct-1";

let workspacePath = "";
let owner = "";

function dockerArgs(): string[] {
  return (execFileAsyncMock.mock.calls.at(-1)?.[1] ?? []) as string[];
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** The flags before the image, which is where --user has to be to apply. */
function runFlags(args: string[]): string[] {
  const image = args.findIndex((arg) => /^starlingai\/sandbox/.test(arg) || arg === process.env["SAI_SANDBOX_IMAGE"]);
  return image >= 0 ? args.slice(0, image) : args;
}

beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), "sai-sandbox-owner-"));
  const { uid, gid } = statSync(workspacePath);
  owner = `${uid}:${gid}`;
  await import("../tools/shell.js");
  await import("../tools/run-test-suite.js");
  await import("../tools/git.js");
});

afterAll(() => {
  rmSync(workspacePath, { recursive: true, force: true });
});

afterEach(() => {
  execFileAsyncMock.mockReset();
});

describe("sandboxUserArgs", () => {
  it("names the owner of the directory, as uid:gid", async () => {
    const { sandboxUserArgs } = await import("../tools/workspace-mount.js");
    expect(sandboxUserArgs(workspacePath)).toEqual(["--user", owner]);
  });

  it("adds no flag for a directory it cannot read, so the image's own user applies", async () => {
    const { sandboxUserArgs } = await import("../tools/workspace-mount.js");
    expect(sandboxUserArgs(join(workspacePath, "missing", "dir"))).toEqual([]);
  });
});

describe("toSandboxPath", () => {
  it("maps the gateway-side root and anything under it to /workspace", async () => {
    const { toSandboxPath } = await import("../tools/workspace-mount.js");
    expect(toSandboxPath(ACCOUNT_ROOT, ACCOUNT_ROOT)).toBe("/workspace");
    expect(toSandboxPath(`${ACCOUNT_ROOT}/`, ACCOUNT_ROOT)).toBe("/workspace");
    expect(toSandboxPath(`${ACCOUNT_ROOT}/generated/e2e-git`, ACCOUNT_ROOT)).toBe("/workspace/generated/e2e-git");
  });

  it("leaves a sandbox path, a sibling directory and an outside path as written", async () => {
    const { toSandboxPath } = await import("../tools/workspace-mount.js");
    expect(toSandboxPath("/workspace/generated", ACCOUNT_ROOT)).toBe("/workspace/generated");
    expect(toSandboxPath(`${ACCOUNT_ROOT}-old/x`, ACCOUNT_ROOT)).toBe(`${ACCOUNT_ROOT}-old/x`);
    expect(toSandboxPath("/tmp/x", ACCOUNT_ROOT)).toBe("/tmp/x");
  });

  it("is the identity when the workspace already is /workspace", async () => {
    const { toSandboxPath } = await import("../tools/workspace-mount.js");
    expect(toSandboxPath("/workspace/generated", "/workspace")).toBe("/workspace/generated");
  });
});

describe("toSandboxCommand", () => {
  it("rewrites the root wherever the command names it, at a path boundary", async () => {
    const { toSandboxCommand } = await import("../tools/workspace-mount.js");
    expect(toSandboxCommand(`cd ${ACCOUNT_ROOT} && node --test generated/a.test.mjs`, ACCOUNT_ROOT))
      .toBe("cd /workspace && node --test generated/a.test.mjs");
    expect(toSandboxCommand(`cat '${ACCOUNT_ROOT}/generated/a.txt';ls ${ACCOUNT_ROOT}`, ACCOUNT_ROOT))
      .toBe("cat '/workspace/generated/a.txt';ls /workspace");
  });

  it("leaves a sibling directory and a command without the root untouched", async () => {
    const { toSandboxCommand } = await import("../tools/workspace-mount.js");
    expect(toSandboxCommand(`ls ${ACCOUNT_ROOT}-old`, ACCOUNT_ROOT)).toBe(`ls ${ACCOUNT_ROOT}-old`);
    expect(toSandboxCommand("ls generated", ACCOUNT_ROOT)).toBe("ls generated");
  });
});

describe("the sandbox tools", () => {
  const ctx = (): ToolContext => ({ sessionId: "s-owner", workspacePath });
  const root = () => workspacePath.replace(/\\/g, "/");

  it("shell_exec runs as the owner and maps the gateway-side workdir and command paths", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });
    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("shell_exec")!.execute(
      { command: `ls ${root()}/generated`, workdir: workspacePath },
      ctx(),
    );
    expect(result.success).toBe(true);
    const args = dockerArgs();
    expect(flagValue(runFlags(args), "--user")).toBe(owner);
    expect(flagValue(args, "-w")).toBe("/workspace");
    expect(args.at(-1)).toBe("mkdir -p '/workspace' && cd '/workspace' && ls /workspace/generated");
  });

  it("run_script runs as the owner and maps a gateway-side path among its arguments", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });
    const { getTool } = await import("../tools/registry.js");
    await getTool("run_script")!.execute({ path: "count.js", args: [`${root()}/generated/in.txt`] }, ctx());
    const args = dockerArgs();
    expect(flagValue(runFlags(args), "--user")).toBe(owner);
    expect(args.at(-1)).toBe("node '/workspace/count.js' '/workspace/generated/in.txt'");
  });

  it("run_test_suite runs as the owner and maps the gateway-side workdir and command", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });
    const { getTool } = await import("../tools/registry.js");
    await getTool("run_test_suite")!.execute(
      { suite: "custom", command: `node --test ${root()}/generated/a.test.mjs`, workdir: `${root()}/generated` },
      ctx(),
    );
    const args = dockerArgs();
    expect(flagValue(runFlags(args), "--user")).toBe(owner);
    expect(flagValue(args, "-w")).toBe("/workspace/generated");
    expect(args.at(-1)).toContain("node --test /workspace/generated/a.test.mjs");
    expect(args.at(-1)).not.toContain(root());
  });

  it("the git sandbox runs as the owner of the directory it binds", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "## main", stderr: "" });
    const { getTool } = await import("../tools/registry.js");
    await getTool("git_status")!.execute({}, { ...ctx(), workspaceScope: "generated" });
    expect(flagValue(runFlags(dockerArgs()), "--user")).toBe(owner);
  });
});
