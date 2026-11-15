/**
 * The suite-wide workspace guard (src/tests/vitest.setup.ts) keeps every test out of the default
 * workspace: `/workspace`, the schema default of `workspacePath`, which on Windows is
 * `<drive>:\workspace`, shared by every checkout and every run on that drive.
 *
 * Each case takes the calls it made back off the guard's record (takeTouches), so that the guard's
 * own afterEach does not fail the case; the last case leaves them there and is expected to fail.
 * The refusals carry the guard's own message, so a guard that silently stopped loading fails these
 * cases rather than passing them by luck on a machine without /workspace.
 */
import { execFile, spawnSync } from "node:child_process";
import fs, { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendOutcome } from "../agent/outcomes.js";
import { ConfigSchema } from "../config/schema.js";

interface WorkspaceGuard { root: string; active: boolean; touches: string[] }
const guard = (globalThis as Record<symbol, unknown>)[Symbol.for("starlingai.test.workspaceGuard")] as WorkspaceGuard;
const GUARD_MESSAGE = "workspace guard";

/** The calls the guard recorded since its last check, which it then forgets. */
const takeTouches = (): string[] => guard.touches.splice(0);
/** Each recorded call without the caller's frame below it. */
const takeCalls = (): string[] => takeTouches().map((touch) => touch.split("\n")[0]!);

/** What `error` says, for an expect on a refusal. */
const refusalOf = (error: unknown) => ({
  code: (error as NodeJS.ErrnoException).code,
  guarded: String((error as Error).message).includes(GUARD_MESSAGE),
});

const caught = (call: () => unknown): unknown => {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("the call went through");
};

it("is installed, for the directory a config without workspacePath works in", () => {
  expect(guard, "src/tests/vitest.setup.ts did not install the workspace guard").toBeDefined();
  expect(guard.root).toBe(resolve(ConfigSchema.parse({}).workspacePath));
});

// It stands down when this checkout lies inside /workspace itself (a container that mounts it there).
describe.runIf(guard?.active)("the default workspace guard", () => {
  const root = guard?.root ?? "";
  let outside = "";

  beforeAll(() => {
    // A real directory beside the guarded one would be the better control, but /workspace's parent
    // is the drive's or the file system's root; a temp dir named like it serves.
    outside = mkdtempSync(join(tmpdir(), "workspace-guard-control-"));
  });
  afterAll(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  it("lets a read find nothing there, as on a runner without /workspace", async () => {
    const ledger = join(root, ".starlingai", "agent_outcomes.ndjson");
    expect(existsSync(ledger)).toBe(false);
    expect(fs.existsSync(join(root, ".starlingai"))).toBe(false);
    expect(refusalOf(caught(() => readFileSync(ledger, "utf8")))).toEqual({ code: "ENOENT", guarded: true });
    expect(refusalOf(await stat(root).catch((error: unknown) => error))).toEqual({ code: "ENOENT", guarded: true });
    expect(refusalOf(await readdir(join(root, "generated")).catch((error: unknown) => error))).toEqual({ code: "ENOENT", guarded: true });
    expect(await promisify(fs.exists)(ledger)).toBe(false);

    expect(takeCalls()).toEqual([
      `fs.existsSync ${ledger}`,
      `fs.existsSync ${join(root, ".starlingai")}`,
      `fs.readFileSync ${ledger}`,
      `fs.promises.stat ${root}`,
      `fs.promises.readdir ${join(root, "generated")}`,
      `fs.exists (promisified) ${ledger}`,
    ]);
  });

  it("refuses a write, sync, callback, promise and stream alike, and writes nothing", async () => {
    const file = join(root, ".starlingai", `guard-probe-${process.pid}-${Date.now()}.json`);
    expect(refusalOf(caught(() => mkdirSync(join(root, ".starlingai"), { recursive: true })))).toEqual({ code: "EACCES", guarded: true });
    expect(refusalOf(caught(() => writeFileSync(file, "{}")))).toEqual({ code: "ENOENT", guarded: true });
    expect(refusalOf(await appendFile(file, "{}\n").catch((error: unknown) => error))).toEqual({ code: "ENOENT", guarded: true });
    const calledBack = await new Promise<unknown>((done) => fs.writeFile(file, "{}", (error) => done(error)));
    expect(refusalOf(calledBack)).toEqual({ code: "ENOENT", guarded: true });
    expect(refusalOf(caught(() => createWriteStream(file)))).toEqual({ code: "ENOENT", guarded: true });
    // A forced remove of something that is not there succeeds there too.
    expect(() => rmSync(file, { force: true })).not.toThrow();

    expect(takeCalls()).toEqual([
      `fs.mkdirSync ${join(root, ".starlingai")}`,
      `fs.writeFileSync ${file}`,
      `fs.promises.appendFile ${file}`,
      `fs.writeFile ${file}`,
      `fs.createWriteStream ${file}`,
      `fs.rmSync ${file}`,
    ]);
    // Asked from a process the guard is not in: none of those calls reached the disk.
    const probe = spawnSync(process.execPath, ["-e", `process.stdout.write(String(require("fs").existsSync(${JSON.stringify(file)})))`], { encoding: "utf8" });
    expect(probe.stdout).toBe("false");
  });

  it("guards either path of a copy or a rename", () => {
    const source = join(outside, "source.txt");
    writeFileSync(source, "kept");
    expect(refusalOf(caught(() => copyFileSync(source, join(root, "copy.txt"))))).toEqual({ code: "ENOENT", guarded: true });
    expect(refusalOf(caught(() => renameSync(join(root, "moved.txt"), join(outside, "moved.txt"))))).toEqual({ code: "ENOENT", guarded: true });
    expect(readFileSync(source, "utf8")).toBe("kept");

    expect(takeCalls()).toEqual([
      `fs.copyFileSync ${join(root, "copy.txt")}`,
      `fs.renameSync ${join(root, "moved.txt")}`,
    ]);
  });

  it("starts no process there", async () => {
    expect(refusalOf(caught(() => spawnSync(process.execPath, ["-v"], { cwd: root })))).toEqual({ code: "ENOENT", guarded: true });
    expect(refusalOf(await promisify(execFile)(process.execPath, ["-v"], { cwd: root }).catch((error: unknown) => error)))
      .toEqual({ code: "ENOENT", guarded: true });

    expect(takeCalls()).toEqual([
      `child_process.spawnSync (cwd) ${root}`,
      `child_process.execFile (cwd) ${root}`,
    ]);
  });

  it("follows the cwd to another drive, where \"/workspace\" goes with it on Windows (auth.test.ts changes the cwd)", () => {
    const cwd = process.cwd();
    process.chdir(outside);
    try {
      expect(existsSync("/workspace/probe")).toBe(false);
      expect(takeCalls()).toEqual([`fs.existsSync ${resolve("/workspace/probe")}`]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("names the caller of each call, the way to find the test's missing workspacePath", () => {
    existsSync(join(root, "probe"));
    const [touch] = takeTouches();
    expect(touch?.split("\n")[1]).toContain("vitest-setup-workspace-guard.test.ts");
  });

  it("lets everything else through, a path whose name only starts like it included", () => {
    const lookalike = join(outside, "workspace", "notes.md");
    mkdirSync(join(outside, "workspace"));
    writeFileSync(lookalike, "mine");
    expect(readFileSync(lookalike, "utf8")).toBe("mine");
    expect(existsSync(`${root}-elsewhere`)).toBe(false);
    expect(existsSync(join(`${root}2`, "notes.md"))).toBe(false);
    expect(spawnSync(process.execPath, ["-e", "process.stdout.write('ran')"], { cwd: outside, encoding: "utf8" }).stdout).toBe("ran");

    expect(takeTouches()).toEqual([]);
  });

  it("records a call the code under test swallowed: the outcomes ledger catches and logs its own errors", () => {
    expect(() => appendOutcome(ConfigSchema.parse({}).workspacePath, {
      ts: new Date().toISOString(), agent: "probe", task: "probe", outcome: "success", iterations: 1, totalTokens: 1,
    })).not.toThrow();

    expect(takeCalls()).toEqual([`fs.mkdirSync ${join(root, ".starlingai")}`]);
  });

  // Expected to fail: the guard's afterEach fails the test, though nothing in it threw. If the guard
  // let it pass, vitest reports this case as failed ("Expect test to fail").
  it.fails("fails a test that reached the default workspace, though the code under test swallowed the error", () => {
    appendOutcome(ConfigSchema.parse({}).workspacePath, {
      ts: new Date().toISOString(), agent: "probe", task: "probe", outcome: "success", iterations: 1, totalTokens: 1,
    });
  });
});
