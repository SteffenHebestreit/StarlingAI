/**
 * The harness reads `node scripts/e2e-env.mjs status --json` through a child process. On Windows a
 * harness whose launching task was stopped has lost its console; a child that inherits it dies at
 * process start with 0xC0000142 and prints nothing, and the old error named neither the exit code
 * nor the hidden console. execFile is mocked here, so no child runs.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ExecCallback = (err: (Error & { code?: unknown; signal?: unknown }) | null, stdout: string, stderr: string) => void;
const calls = vi.hoisted(() => [] as Array<{ file: string; args: string[]; options: Record<string, unknown>; done: (...a: Parameters<ExecCallback>) => void }>);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = (file: string, args: string[], options: Record<string, unknown>, done: ExecCallback) => {
    calls.push({ file, args, options, done });
  };
  return { ...actual, execFile, default: { ...actual, execFile } };
});

const { environmentStatusSource } = await import("../e2e/services.js");

const repo = mkdtempSync(join(tmpdir(), "sai-e2e-env-spawn-"));
mkdirSync(join(repo, "scripts"), { recursive: true });
writeFileSync(join(repo, "scripts", "e2e-env.mjs"), "");
afterAll(() => rmSync(repo, { recursive: true, force: true }));
beforeEach(() => {
  calls.length = 0;
});

/** Starts one status read and answers the spawn it made the way `answer` says. */
async function statusWith(answer: (done: (...a: Parameters<ExecCallback>) => void) => void) {
  const source = environmentStatusSource(repo, 0);
  if (!source) throw new Error("expected a status source for a repo with scripts/e2e-env.mjs");
  const pending = source();
  expect(calls).toHaveLength(1);
  answer(calls[0]!.done);
  return { result: await pending, call: calls[0]! };
}

describe("e2e-env status child", () => {
  it("runs with a hidden console of its own", async () => {
    const { call } = await statusWith((done) => done(null, '{"ready":{}}', ""));
    expect(call.file).toBe(process.execPath);
    expect(call.args).toEqual([join(repo, "scripts", "e2e-env.mjs"), "status", "--json"]);
    expect(call.options["windowsHide"]).toBe(true);
  });

  it("names the exit code when the child dies before printing anything", async () => {
    const dead = Object.assign(new Error(`Command failed: ${process.execPath} e2e-env.mjs status --json\n`), { code: 3221225794, signal: null });
    const { result } = await statusWith((done) => done(dead, "", ""));
    expect(result).toEqual({ error: "pnpm e2e:env status --json gave no status (no output; exit code 3221225794 (0xC0000142))" });
  });

  it("names the signal that stopped it, next to the first stderr line", async () => {
    const killed = Object.assign(new Error("Command failed"), { code: null, signal: "SIGTERM", killed: true });
    const { result } = await statusWith((done) => done(killed, "", "e2e:env: docker ps hung\nmore"));
    expect(result).toEqual({ error: "pnpm e2e:env status --json gave no status (e2e:env: docker ps hung; signal SIGTERM)" });
  });

  it("says when the child could not be started at all", async () => {
    const missing = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
    const { result } = await statusWith((done) => done(missing, "", ""));
    expect(result).toEqual({ error: "pnpm e2e:env status --json gave no status (no output; failed to run: ENOENT)" });
  });

  it("names a clean exit whose output is not the status", async () => {
    const { result } = await statusWith((done) => done(null, "not json", ""));
    expect(result).toEqual({ error: "pnpm e2e:env status --json gave no status (no output; exit code 0)" });
  });

  it("still reads the status a failing exit prints", async () => {
    const missingSomething = Object.assign(new Error("Command failed"), { code: 1, signal: null });
    const { result } = await statusWith((done) => done(missingSomething, '{"ready":{"mail":false}}', ""));
    expect(result).toEqual({ json: { ready: { mail: false } } });
  });
});
