import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveLabScratch, labScratchRoot } from "../harness-lab/scratch.js";
import { resolveDockerWorkspaceBind } from "../tools/workspace-mount.js";
// @ts-expect-error — plain .mjs, no types (as tests/docker-socket-proxy.test.ts imports it)
import { isAllowedBindSource } from "../../../../docker/docker-socket-proxy/bind-policy.mjs";

/**
 * The lab's attempt workspaces must be bindable into the code sandbox. The first nightly run made
 * them under its --out in .starlingai, which the socket proxy refuses to bind, and every task that
 * ran code failed there: "Binds source not allowed".
 */
const MOUNT_SOURCE = "F:\\StarlingAI";
/** The host path a sandbox bind of `workspacePath` names, as the gateway builds it in the container. */
const bindSource = (workspacePath: string) => {
  const spec = resolveDockerWorkspaceBind(workspacePath, { mountSource: MOUNT_SOURCE });
  return spec.slice(0, spec.lastIndexOf(":/workspace"));
};

describe("where attempts run", () => {
  it("is a place the socket proxy lets a sandbox bind, and the run's --out is not", () => {
    const attempt = `${labScratchRoot("/workspace", "2026-10-22T00-30-09-173Z-4f2a1c")}/base-e2e.sandbox-primes-1`.replace(/\\/g, "/");
    expect(attempt).toBe("/workspace/generated/.harness-lab/2026-10-22T00-30-09-173Z-4f2a1c/base-e2e.sandbox-primes-1");
    expect(isAllowedBindSource(bindSource(attempt), [MOUNT_SOURCE])).toBe(true);
    // Where the first nightly run put them: refused, as it should be (state and secrets live there).
    expect(isAllowedBindSource(bindSource("/workspace/.starlingai/harness-lab/nightly/run-1/scratch/base-e2e.sandbox-primes-1"), [MOUNT_SOURCE])).toBe(false);
  });

  it("keeps a run id from leaving its directory", () => {
    expect(labScratchRoot("/workspace", "../../etc").replace(/\\/g, "/")).toBe("/workspace/generated/.harness-lab/.._.._etc");
  });
});

describe("when a run stops", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), "sai-lab-scratch-")); dirs.push(d); return d; };
  const write = (path: string, body: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, body, "utf8"); };

  it("moves its attempts under its --out and leaves generated/ as it was", () => {
    const ws = tmp();
    const out = join(tmp(), "run-1");
    const root = labScratchRoot(ws, "run-1");
    write(join(root, "base-t-1", "generated", "primes.py"), "print(2)");
    archiveLabScratch(root, out);
    expect(readFileSync(join(out, "scratch", "base-t-1", "generated", "primes.py"), "utf8")).toBe("print(2)");
    expect(existsSync(join(ws, "generated", ".harness-lab"))).toBe(false);
    expect(existsSync(join(ws, "generated"))).toBe(true);
  });

  it("merges with what an earlier stop of the same run moved, newer attempts replacing older", () => {
    const ws = tmp();
    const out = join(tmp(), "run-1");
    const root = labScratchRoot(ws, "run-1");
    write(join(root, "base-t-1", "a.txt"), "first stop");
    archiveLabScratch(root, out);
    write(join(root, "base-t-1", "a.txt"), "second stop");
    write(join(root, "base-t-2", "b.txt"), "new attempt");
    archiveLabScratch(root, out);
    expect(readFileSync(join(out, "scratch", "base-t-1", "a.txt"), "utf8")).toBe("second stop");
    expect(readFileSync(join(out, "scratch", "base-t-2", "b.txt"), "utf8")).toBe("new attempt");
  });

  it("leaves another run's attempts where they are, and does nothing without any", () => {
    const ws = tmp();
    write(join(labScratchRoot(ws, "run-2"), "base-t-1", "c.txt"), "still running");
    const root = labScratchRoot(ws, "run-1");
    write(join(root, "base-t-1", "a.txt"), "done");
    archiveLabScratch(root, join(tmp(), "run-1"));
    expect(readFileSync(join(labScratchRoot(ws, "run-2"), "base-t-1", "c.txt"), "utf8")).toBe("still running");
    expect(() => archiveLabScratch(labScratchRoot(ws, "never-ran"), join(tmp(), "x"))).not.toThrow();
  });
});
