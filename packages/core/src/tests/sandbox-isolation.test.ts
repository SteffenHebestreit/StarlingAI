/**
 * WHAT A ROOT SANDBOX MUST NOT WRITE IN ITS BIND (review 2026-10-11).
 *
 * Running each sandbox as the owner of its workspace made it root in the compose deployment, and
 * the bind holds gateway state: the bound directory's own state directory (workspace-scope durable
 * memory) and, where the shared root lies inside it, the shared root's (accounts.json, approvals/).
 * An auth-off session's root IS the shared root, so its sandbox also had every place the config
 * loader reads (the zones, a new .jsonc at the root, runtime/runtime.overrides.json).
 * sandboxIsolationArgs masks every state directory in the bind with an empty read-only tmpfs; for a
 * sandbox that is not full-scope with the shared root in its bind, sandboxBindSpec makes the bind
 * read-only, only generated/ is bound again writable, and users/ is masked. On Docker Desktop neither
 * a mask (the bind is case-insensitive) nor a file's mode (host-made entries are 0777) protects the
 * state in a bind, and a read-only bind stops writes, not reads. So a full-scope shell, script or
 * test sandbox gets no bind of its root at all, only the zones it maintains and generated/, each at
 * /workspace/<zone>; the full-scope git repo bind is read-only with those zones writable, and runs as
 * the bind's owner, which git needs.
 *
 * node:fs is the real module behind spies: a test can give a path an owner (statSync) or a zone
 * (existsSync) in the compose layout, which does not exist on the machine running the tests.
 * execFile is mocked, so no docker runs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/registry.js";

const execFileAsyncMock = vi.fn();

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  (execFile as unknown as Record<PropertyKey, unknown>)[promisify.custom] = execFileAsyncMock;
  return { execFile };
});

/** Owners and zones of compose-layout paths, set per test. */
const fakeOwners = new Map<string, number>();
const fakeExisting = new Set<string>();
const norm = (p: unknown) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
/** A path of the compose layout (/workspace/...), which the gateway would see but this machine does not. */
const isComposePath = (p: unknown) => norm(p) === "/workspace" || norm(p).startsWith("/workspace/");

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const statSync = vi.fn((path: Parameters<typeof real.statSync>[0], options?: Parameters<typeof real.statSync>[1]) => {
    const uid = fakeOwners.get(norm(path));
    if (uid !== undefined) return { uid, gid: uid } as ReturnType<typeof real.statSync>;
    if (isComposePath(path)) throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" });
    return real.statSync(path, options);
  });
  const existsSync = vi.fn((path: Parameters<typeof real.existsSync>[0]) =>
    isComposePath(path) ? fakeExisting.has(norm(path)) : real.existsSync(path));
  // A compose-layout directory is never created on this machine (on Windows "/workspace" is the
  // root of the current drive).
  const mkdirSync = vi.fn((path: Parameters<typeof real.mkdirSync>[0], options?: Parameters<typeof real.mkdirSync>[1]) =>
    isComposePath(path) ? undefined : real.mkdirSync(path, options));
  return { ...real, statSync, existsSync, mkdirSync, default: { ...real, statSync, existsSync, mkdirSync } };
});

const HOST_SOURCE = "/opt/deploy/repo";
const SHARED = "/workspace/workspace";
const CALLER_WS = "/workspace/workspace/users/acct-1";
const ACCOUNT = "alice-0123456789abcdef";
const MASK = (at: string) => `--tmpfs=${at}:ro,size=4k`;

let tempRoot = "";
let shared = "";
let configDir = "";
let savedMountSource: string | undefined;
let savedConfigPath: string | undefined;
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function dockerArgs(): string[] {
  return (execFileAsyncMock.mock.calls.at(-1)?.[1] ?? []) as string[];
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Every `-v` spec that binds something read-only. */
function readOnlyBinds(args: string[]): string[] {
  return args.flatMap((arg, i) => (args[i - 1] === "-v" && arg.endsWith(":ro") ? [arg] : []));
}

/** Every `-v` spec that binds something writable. */
function writableBinds(args: string[]): string[] {
  return args.flatMap((arg, i) => (args[i - 1] === "-v" && !arg.endsWith(":ro") ? [arg] : []));
}

function masks(args: string[]): string[] {
  return args.filter((arg) => arg.startsWith("--tmpfs=") && arg.endsWith(":ro,size=4k"));
}

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "sai-sandbox-isolation-"));
  shared = join(tempRoot, "shared");
  configDir = join(tempRoot, "config");
  for (const dir of [join(shared, "agents"), join(shared, "scenes"), join(shared, "generated"), join(shared, "users", "acct-1"), configDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(configDir, "starlingai.json"), JSON.stringify({ workspacePath: shared }), "utf8");
  savedConfigPath = process.env["SAI_CONFIG_PATH"];
  process.env["SAI_CONFIG_PATH"] = join(configDir, "starlingai.json");
  (await import("../config/loader.js")).resetConfigForTests();
  await import("../tools/shell.js");
  await import("../tools/run-test-suite.js");
  await import("../tools/git.js");
});

afterAll(async () => {
  if (savedConfigPath === undefined) delete process.env["SAI_CONFIG_PATH"];
  else process.env["SAI_CONFIG_PATH"] = savedConfigPath;
  (await import("../config/loader.js")).resetConfigForTests();
  rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  savedMountSource = process.env["SAI_WORKSPACE_MOUNT_SOURCE"];
  process.env["SAI_WORKSPACE_MOUNT_SOURCE"] = HOST_SOURCE;
  // A Linux gateway, whatever runs the tests.
  Object.defineProperty(process, "platform", { ...realPlatform, value: "linux" });
});

afterEach(() => {
  if (savedMountSource === undefined) delete process.env["SAI_WORKSPACE_MOUNT_SOURCE"];
  else process.env["SAI_WORKSPACE_MOUNT_SOURCE"] = savedMountSource;
  Object.defineProperty(process, "platform", realPlatform);
  fakeOwners.clear();
  fakeExisting.clear();
  execFileAsyncMock.mockReset();
  vi.mocked(fs.statSync).mockClear();
  vi.mocked(fs.mkdirSync).mockClear();
});

describe("sandboxIsolationArgs in the compose layout", () => {
  it("masks an account's own state directory, keeps its bind writable, and adds nothing of the shared root outside it", async () => {
    const { sandboxBindSpec, sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    const input = { workspacePath: CALLER_WS, workspaceScope: "generated", bind: "caller" } as const;
    const args = sandboxIsolationArgs(input, { sharedRoot: SHARED });
    expect(masks(args)).toEqual([MASK("/workspace/.starlingai")]);
    expect(args.filter((arg) => arg === "-v")).toEqual([]);
    expect(sandboxBindSpec("src:/workspace", input, { sharedRoot: SHARED })).toBe("src:/workspace");
  });

  it("masks it even before it exists, so a sandbox cannot create it and plant memory there", async () => {
    const { sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    expect(fs.existsSync(`${CALLER_WS}/.starlingai`)).toBe(false);
    const args = sandboxIsolationArgs({ workspacePath: CALLER_WS, bind: "caller" }, { sharedRoot: SHARED });
    expect(masks(args)).toEqual([MASK("/workspace/.starlingai")]);
  });

  it("makes the shared root read-only to a non-full sandbox, binds generated/ writable from its HOST path and masks users/", async () => {
    const { sandboxBindSpec, sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    for (const workspaceScope of [undefined, "generated"]) {
      const input = { workspacePath: SHARED, workspaceScope, bind: "caller" } as const;
      expect(sandboxBindSpec("src:/workspace", input, { sharedRoot: SHARED })).toBe("src:/workspace:ro");
      const args = sandboxIsolationArgs(input, { sharedRoot: SHARED });
      expect(masks(args)).toEqual([MASK("/workspace/.starlingai"), MASK("/workspace/users")]);
      expect(flagValue(args, "-v")).toBe(`${HOST_SOURCE}/workspace/generated:/workspace/generated`);
      expect(readOnlyBinds(args)).toEqual([]);
    }
  });

  it("gives a full-scope shell no bind of the shared root, only the zones that are there, writable from their HOST paths", async () => {
    const { callerSandboxMounts } = await import("../tools/workspace-mount.js");
    for (const zone of ["agents", "scenes", "generated"]) fakeExisting.add(`${SHARED}/${zone}`);
    const mounts = callerSandboxMounts({ workspacePath: SHARED, workspaceScope: "full" }, { sharedRoot: SHARED });
    if ("error" in mounts) throw new Error(mounts.error);
    // jobs/ and tools/ are not there: nothing is bound, and docker creates nothing.
    expect(writableBinds(mounts.args)).toEqual([
      `${HOST_SOURCE}/workspace/agents:/workspace/agents`,
      `${HOST_SOURCE}/workspace/scenes:/workspace/scenes`,
      `${HOST_SOURCE}/workspace/generated:/workspace/generated`,
    ]);
    // Nothing else: not the shared root, not the mount source, and no mask over a state directory
    // that is not in the sandbox under any spelling.
    expect(readOnlyBinds(mounts.args)).toEqual([]);
    expect(mounts.args.filter((arg) => arg.startsWith("--tmpfs"))).toEqual([]);
    expect(mounts.args.filter((arg, i) => mounts.args[i - 1] === "-v" && /:\/workspace(:ro)?$/.test(arg))).toEqual([]);
  });

  it("refuses to hand a full-scope shell its root through the bind helpers", async () => {
    const { sandboxBindSpec, sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    const input = { workspacePath: SHARED, workspaceScope: "full", bind: "caller" } as const;
    expect(() => sandboxBindSpec("src:/workspace", input, { sharedRoot: SHARED })).toThrow(/only the zones/);
    expect(() => sandboxIsolationArgs(input, { sharedRoot: SHARED })).toThrow(/only the zones/);
  });

  it("makes the full-scope git repo bind read-only, binds the zones writable at their place in it, and masks the repo root's and the shared root's state", async () => {
    const { sandboxBindSpec, sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    for (const zone of ["agents", "jobs", "scenes", "tools", "generated"]) fakeExisting.add(`${SHARED}/${zone}`);
    const input = { workspacePath: SHARED, workspaceScope: "full", bind: "repo" } as const;
    expect(sandboxBindSpec("src:/workspace", input, { sharedRoot: SHARED })).toBe("src:/workspace:ro");
    const args = sandboxIsolationArgs(input, { sharedRoot: SHARED });
    expect(masks(args)).toEqual([MASK("/workspace/.starlingai"), MASK("/workspace/workspace/.starlingai")]);
    expect(writableBinds(args)).toEqual(["agents", "jobs", "scenes", "tools", "generated"]
      .map((zone) => `${HOST_SOURCE}/workspace/${zone}:/workspace/workspace/${zone}`));
  });

  it("keeps a full-scope named-volume repo bind read-only, and refuses the shell, with no zone to bind from a host path", async () => {
    delete process.env["SAI_WORKSPACE_MOUNT_SOURCE"];
    const { callerSandboxMounts, FULL_SCOPE_NO_ZONES_SANDBOX_ERROR, sandboxBindSpec, sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    for (const zone of ["agents", "generated"]) fakeExisting.add(`${SHARED}/${zone}`);
    const input = { workspacePath: SHARED, workspaceScope: "full", bind: "repo" } as const;
    expect(sandboxBindSpec("gc-workspace:/workspace", input, { sharedRoot: SHARED })).toBe("gc-workspace:/workspace:ro");
    expect(writableBinds(sandboxIsolationArgs(input, { sharedRoot: SHARED }))).toEqual([]);
    expect(callerSandboxMounts({ workspacePath: SHARED, workspaceScope: "full" }, { sharedRoot: SHARED })).toEqual({ error: FULL_SCOPE_NO_ZONES_SANDBOX_ERROR });
  });

  it("refuses a full-scope shell where none of its zones is there", async () => {
    const { callerSandboxMounts, FULL_SCOPE_NO_ZONES_SANDBOX_ERROR } = await import("../tools/workspace-mount.js");
    expect(callerSandboxMounts({ workspacePath: SHARED, workspaceScope: "full" }, { sharedRoot: SHARED })).toEqual({ error: FULL_SCOPE_NO_ZONES_SANDBOX_ERROR });
  });

  it("masks every state directory in a named-volume bind and keeps that whole-volume bind read-only", async () => {
    delete process.env["SAI_WORKSPACE_MOUNT_SOURCE"];
    const { sandboxBindSpec, sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    const input = { workspacePath: CALLER_WS, workspaceScope: "generated", bind: "caller" } as const;
    // The shared root is in the whole-volume bind, and there is no host path to bind generated/ from.
    expect(sandboxBindSpec("gc-workspace:/workspace", input, { sharedRoot: SHARED })).toBe("gc-workspace:/workspace:ro");
    const args = sandboxIsolationArgs(input, { sharedRoot: SHARED });
    // The whole volume is bound at /workspace, so each directory sits at its gateway path.
    expect(masks(args)).toEqual([
      MASK("/workspace/.starlingai"),
      MASK("/workspace/workspace/users/acct-1/.starlingai"),
      MASK("/workspace/workspace/.starlingai"),
    ]);
    expect(args.filter((arg) => arg === "-v")).toEqual([]);
  });
});

describe("an account's root, which holds no gateway state (workspaceStateDir)", () => {
  // A segment of the shape every account's root has; "acct-1" above is not one.
  const ACCOUNT_WS = `/workspace/workspace/users/${ACCOUNT}`;

  it("masks no state directory that does not exist there, and creates none", async () => {
    const { sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    const args = sandboxIsolationArgs({ workspacePath: ACCOUNT_WS, workspaceScope: "generated", bind: "caller" }, { sharedRoot: SHARED });
    expect(masks(args)).toEqual([]);
    expect(vi.mocked(fs.mkdirSync).mock.calls.map(([path]) => norm(path))).not.toContain(`${ACCOUNT_WS}/.starlingai`);
  });

  it("masks an old one that is still there", async () => {
    const { sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    fakeExisting.add(`${ACCOUNT_WS}/.starlingai`);
    const args = sandboxIsolationArgs({ workspacePath: ACCOUNT_WS, workspaceScope: "generated", bind: "caller" }, { sharedRoot: SHARED });
    expect(masks(args)).toEqual([MASK("/workspace/.starlingai")]);
  });

  it("still masks the shared root's state where the whole volume is bound", async () => {
    delete process.env["SAI_WORKSPACE_MOUNT_SOURCE"];
    const { sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    const args = sandboxIsolationArgs({ workspacePath: ACCOUNT_WS, workspaceScope: "generated", bind: "caller" }, { sharedRoot: SHARED });
    expect(masks(args)).toEqual([MASK("/workspace/.starlingai"), MASK("/workspace/workspace/.starlingai")]);
  });

  it("masks an old one only until the boot's move is complete; after that it is the account's own file", async () => {
    const { sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    const root = join(shared, "users", ACCOUNT);
    mkdirSync(join(root, ".starlingai"), { recursive: true });
    const marker = join(shared, ".starlingai", "users", ".relocated-v1");
    try {
      const input = { workspacePath: root, workspaceScope: "generated", bind: "caller" } as const;
      expect(masks(sandboxIsolationArgs(input, { sharedRoot: shared }))).toEqual([MASK("/workspace/.starlingai")]);
      mkdirSync(join(shared, ".starlingai", "users"), { recursive: true });
      writeFileSync(marker, "");
      expect(masks(sandboxIsolationArgs(input, { sharedRoot: shared }))).toEqual([]);
    } finally {
      rmSync(join(root, ".starlingai"), { recursive: true, force: true });
      rmSync(marker, { force: true });
    }
  });

  it("does not create the state directory in a new account's real root", async () => {
    const { sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    const root = join(shared, "users", ACCOUNT);
    const args = sandboxIsolationArgs({ workspacePath: root, workspaceScope: "generated", bind: "caller" }, { sharedRoot: shared });
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(join(root, ".starlingai"))).toBe(false);
    expect(masks(args)).toEqual([]);
  });
});

describe("a new account's first sandbox run", () => {
  it("creates the caller's root on the gateway side before it reads the owner", async () => {
    const { sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    const root = join(tempRoot, "users", "acct-new");
    const args = sandboxIsolationArgs({ workspacePath: root, workspaceScope: "generated", bind: "caller" }, { sharedRoot: shared });
    const { uid, gid } = fs.statSync(root);
    expect(flagValue(args, "--user")).toBe(`${uid}:${gid}`);
    // The masked state directory too, so docker does not create it as root.
    expect(fs.existsSync(join(root, ".starlingai"))).toBe(true);
  });

  it("calls mkdir before stat for the caller's bind, and creates nothing for the repo bind", async () => {
    const { sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    fakeOwners.set(CALLER_WS, 2222).set("/workspace", 1111);
    sandboxIsolationArgs({ workspacePath: CALLER_WS, workspaceScope: "generated", bind: "caller" }, { sharedRoot: SHARED });
    const mkdirOrder = vi.mocked(fs.mkdirSync).mock.calls.findIndex(([path]) => norm(path) === CALLER_WS);
    const statOrder = vi.mocked(fs.statSync).mock.calls.findIndex(([path]) => norm(path) === CALLER_WS);
    expect(mkdirOrder).toBeGreaterThanOrEqual(0);
    expect(statOrder).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(fs.mkdirSync).mock.invocationCallOrder[mkdirOrder]!)
      .toBeLessThan(vi.mocked(fs.statSync).mock.invocationCallOrder[statOrder]!);

    vi.mocked(fs.mkdirSync).mockClear();
    sandboxIsolationArgs({ workspacePath: SHARED, workspaceScope: "full", bind: "repo" }, { sharedRoot: SHARED });
    expect(vi.mocked(fs.mkdirSync).mock.calls.map(([path]) => norm(path))).not.toContain("/workspace");
  });
});

describe("a Windows-native gateway", () => {
  // Node reports uid and gid 0 for every path on Windows, so --user would make every sandbox root.
  it("passes no --user, and keeps the masks", async () => {
    const { sandboxIsolationArgs, sandboxUserArgs } = await import("../tools/workspace-mount.js");
    const root = join(shared, "users", "acct-1");
    expect(sandboxUserArgs(root, "win32")).toEqual([]);
    expect(sandboxUserArgs(root, "linux")).toEqual(["--user", `${fs.statSync(root).uid}:${fs.statSync(root).gid}`]);

    const args = sandboxIsolationArgs({ workspacePath: root, bind: "caller" }, { platform: "win32", sharedRoot: shared });
    expect(args).not.toContain("--user");
    expect(masks(args)).toEqual([MASK("/workspace/.starlingai")]);
  });

  it("reads the platform the gateway runs on", async () => {
    Object.defineProperty(process, "platform", { ...realPlatform, value: "win32" });
    execFileAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });
    const { getTool } = await import("../tools/registry.js");
    await getTool("shell_exec")!.execute({ command: "ls" }, { sessionId: "s-win32", workspacePath: join(shared, "users", "acct-1") });
    expect(dockerArgs()).not.toContain("--user");

    Object.defineProperty(process, "platform", { ...realPlatform, value: "linux" });
    await getTool("shell_exec")!.execute({ command: "ls" }, { sessionId: "s-linux", workspacePath: join(shared, "users", "acct-1") });
    expect(dockerArgs()).toContain("--user");
  });
});

describe("the owner each git bind runs as", () => {
  it("is the owner of /workspace for the full-scope repo bind, and of the caller's root for the narrowed one", async () => {
    fakeOwners.set("/workspace", 1111).set(CALLER_WS, 2222);
    execFileAsyncMock.mockResolvedValue({ stdout: "## main", stderr: "" });
    const { getTool } = await import("../tools/registry.js");

    await getTool("git_status")!.execute({}, { sessionId: "s-full", workspacePath: CALLER_WS, workspaceScope: "full" });
    expect(flagValue(dockerArgs(), "--user")).toBe("1111:1111");

    await getTool("git_status")!.execute({}, { sessionId: "s-generated", workspacePath: CALLER_WS, workspaceScope: "generated" });
    expect(flagValue(dockerArgs(), "--user")).toBe("2222:2222");
  });
});

describe("a full-scope sandbox runs as its bind's owner, root included", () => {
  // Its bind is read-only but for the zones it maintains, so the gateway's state in it is safe from
  // root too, and git reads a repository only as its owner: as uid 1000 it is "dubious ownership".
  it("gets the owner's --user, root's where the owner is root, for the repo bind and the shell", async () => {
    const { callerSandboxMounts, sandboxIsolationArgs } = await import("../tools/workspace-mount.js");
    fakeExisting.add(`${SHARED}/agents`);
    for (const uid of [0, 1111]) {
      fakeOwners.set("/workspace", uid).set(SHARED, uid);
      expect(flagValue(sandboxIsolationArgs({ workspacePath: SHARED, workspaceScope: "full", bind: "repo" }, { sharedRoot: SHARED }), "--user"), `repo ${uid}`).toBe(`${uid}:${uid}`);
      const mounts = callerSandboxMounts({ workspacePath: SHARED, workspaceScope: "full" }, { sharedRoot: SHARED });
      expect("args" in mounts && flagValue(mounts.args, "--user"), `shell ${uid}`).toBe(`${uid}:${uid}`);
    }
  });

  it("as the git tools issue it, read-only, with safe.directory for a run that is not the owner's", async () => {
    fakeOwners.set("/workspace", 0);
    execFileAsyncMock.mockResolvedValue({ stdout: "## main", stderr: "" });
    const { getTool } = await import("../tools/registry.js");
    await getTool("git_status")!.execute({}, { sessionId: "s-full-root", workspacePath: SHARED, workspaceScope: "full" });
    expect(flagValue(dockerArgs(), "--user")).toBe("0:0");
    expect(readOnlyBinds(dockerArgs())).toEqual([`${HOST_SOURCE}:/workspace:ro`]);
    const env = dockerArgs().flatMap((arg, i, all) => (all[i - 1] === "-e" ? [arg] : []));
    expect(env).toEqual(["GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=safe.directory", "GIT_CONFIG_VALUE_0=/workspace"]);
    // Before the image: docker's own flags, not git's.
    expect(dockerArgs().indexOf("GIT_CONFIG_COUNT=1")).toBeLessThan(dockerArgs().indexOf("starlingai/sandbox:latest"));
  });
});

describe("the sandbox tools on an auth-off session's root, which is the shared root", () => {
  const ctx = (workspaceScope?: "full" | "generated"): ToolContext => ({ sessionId: "s-isolation", workspacePath: shared, workspaceScope });
  const root = () => shared.replace(/[/\\]+$/, "");

  beforeEach(() => {
    execFileAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });
  });

  it.each([
    ["shell_exec", { command: "ls" }],
    ["run_script", { path: "count.js" }],
    ["run_test_suite", { suite: "vitest" }],
    ["git_status", {}],
  ] as const)("%s binds the shared root read-only with generated/ writable, and masks its state and users/", async (tool, args) => {
    const { getTool } = await import("../tools/registry.js");
    await getTool(tool)!.execute({ ...args }, ctx("generated"));
    expect(readOnlyBinds(dockerArgs())).toEqual([`${root()}:/workspace:ro`]);
    expect(dockerArgs()).toContain(`${root()}/generated:/workspace/generated`);
    expect(masks(dockerArgs())).toEqual([MASK("/workspace/.starlingai"), MASK("/workspace/users")]);
  });

  it("a full-scope shell, script or test sandbox has only the zones that are there and generated/, and no bind of the root", async () => {
    const { getTool } = await import("../tools/registry.js");
    // agents/, scenes/ and generated/ are there (beforeAll); jobs/ and tools/ are not. The state
    // directory and users/ are there too, and must not be in the sandbox under any spelling: the
    // root is not bound, so nothing reaches them.
    mkdirSync(join(shared, ".starlingai"), { recursive: true });
    const zones = ["agents", "scenes", "generated"].map((zone) => `${root()}/${zone}:/workspace/${zone}`);
    for (const [tool, args] of [["shell_exec", { command: "ls" }], ["run_script", { path: "count.js" }], ["run_test_suite", { suite: "vitest" }]] as const) {
      const result = await getTool(tool)!.execute({ ...args }, ctx("full"));
      expect(result.success, tool).toBe(true);
      expect(writableBinds(dockerArgs()), tool).toEqual(zones);
      expect(readOnlyBinds(dockerArgs()), tool).toEqual([]);
      expect(masks(dockerArgs()), tool).toEqual([]);
      const sources = dockerArgs().flatMap((arg, i, all) => (all[i - 1] === "-v" ? [arg.slice(0, arg.lastIndexOf(":/workspace"))] : []));
      expect(sources.some((source) => source === root() || /[/\\](\.starlingai|users)$/i.test(source)), tool).toBe(false);
    }
  });

  it("the full-scope git repo bind keeps the tree read-only but for the zones that are there and generated/", async () => {
    const { getTool } = await import("../tools/registry.js");
    const zones = ["agents", "scenes", "generated"].map((zone) => `${root()}/${zone}:/workspace/${zone}`);
    await getTool("git_status")!.execute({}, ctx("full"));
    expect(readOnlyBinds(dockerArgs())).toEqual([`${root()}:/workspace:ro`]);
    expect(writableBinds(dockerArgs())).toEqual(zones);
    expect(masks(dockerArgs())).toEqual([MASK("/workspace/.starlingai")]);
  });

  it.each([
    ["shell_exec", { command: "ls" }],
    ["run_script", { path: "count.js" }],
    ["run_test_suite", { suite: "vitest" }],
  ] as const)("%s refuses a full-scope run where no zone can be bound, and runs nothing", async (tool, args) => {
    const { getTool } = await import("../tools/registry.js");
    const empty = mkdtempSync(join(tempRoot, "no-zones-"));
    const result = await getTool(tool)!.execute({ ...args }, { sessionId: "s-no-zones", workspacePath: empty, workspaceScope: "full" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/none of the workspace zones.*Nothing was run/);
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });
});

describe("the path the model wrote, where the whole named volume is bound", () => {
  // The sandbox has the whole volume at /workspace there and sees the caller's root at its gateway
  // path, so mapping that path to /workspace sent `cd <root>` to the volume's top.
  beforeEach(() => {
    execFileAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });
  });

  it("stays as written for a named volume, and maps to /workspace where the caller's own root is bound", async () => {
    const { getTool } = await import("../tools/registry.js");
    // Behind a named volume only the shared root runs (an account's root is refused, below).
    const sharedCommand = `cd ${SHARED}/generated && ls`;
    delete process.env["SAI_WORKSPACE_MOUNT_SOURCE"];
    await getTool("shell_exec")!.execute({ command: sharedCommand, workdir: SHARED }, { sessionId: "s-volume", workspacePath: SHARED, workspaceScope: "generated" });
    expect(flagValue(dockerArgs(), "-w")).toBe(SHARED);
    expect(dockerArgs().at(-1)).toContain(sharedCommand);

    const command = `cd ${CALLER_WS} && ls generated`;
    process.env["SAI_WORKSPACE_MOUNT_SOURCE"] = HOST_SOURCE;
    await getTool("shell_exec")!.execute({ command, workdir: CALLER_WS }, { sessionId: "s-host", workspacePath: CALLER_WS, workspaceScope: "generated" });
    expect(flagValue(dockerArgs(), "-w")).toBe("/workspace");
    expect(dockerArgs().at(-1)).toContain("cd /workspace && ls generated");
  });
});

describe("an account's root where the bind cannot be narrowed to it (a named volume)", () => {
  // The whole volume was bound, with users/ unmasked because the caller's own root is in it: an
  // account's sandbox had every other account's workspace.
  const ACCOUNT_WS = `/workspace/workspace/users/${ACCOUNT}`;

  beforeEach(() => {
    delete process.env["SAI_WORKSPACE_MOUNT_SOURCE"];
    execFileAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });
  });

  it.each([
    ["shell_exec", { command: "ls" }],
    ["run_script", { path: "count.js" }],
    ["run_test_suite", { suite: "vitest" }],
  ] as const)("%s refuses and runs nothing", async (tool, args) => {
    const { getTool } = await import("../tools/registry.js");
    for (const workspacePath of [ACCOUNT_WS, CALLER_WS]) {
      for (const workspaceScope of ["generated", undefined] as const) {
        const result = await getTool(tool)!.execute({ ...args }, { sessionId: "s-unnarrowed", workspacePath, workspaceScope });
        expect(result.success, `${workspacePath} ${workspaceScope}`).toBe(false);
        expect(result.error).toMatch(/named volume.*Nothing was run/);
      }
    }
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it("is told apart from the shared root, which keeps the whole-volume bind, and from a host-path source", async () => {
    const { callerSandboxBind } = await import("../tools/workspace-mount.js");
    expect(callerSandboxBind(ACCOUNT_WS, { sharedRoot: SHARED })).toBeNull();
    expect(callerSandboxBind(`${SHARED}/users/notes/deeper`, { sharedRoot: SHARED })).toBeNull();
    expect(callerSandboxBind(SHARED, { sharedRoot: SHARED })).toBe("gc-workspace:/workspace");
    process.env["SAI_WORKSPACE_MOUNT_SOURCE"] = HOST_SOURCE;
    expect(callerSandboxBind(ACCOUNT_WS, { sharedRoot: SHARED })).toBe(`${HOST_SOURCE}/workspace/users/${ACCOUNT}:/workspace`);
  });
});
