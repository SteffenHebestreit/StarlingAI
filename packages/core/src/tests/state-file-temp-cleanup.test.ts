/**
 * A state write that fails leaves no temp file behind (2026-11-14).
 *
 * The state files are written to `<file>.<pid>.tmp` and renamed over the file. A rename that failed
 * removed the temp file, but a write that failed did not: a disk that filled up halfway through left
 * part of the state (account records, tombstones, an NDJSON ledger) in a temp file nothing ever
 * removed. The harness lab's own temp-and-rename writes removed nothing at all. Each write now removes
 * its temp file whatever failed, and throws the failure's own error, not the clean-up's.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Faults a test can switch on for temp files (`*.tmp`) only: a write cut short after part of its
 *  text, a rename refused, a removal refused. `thrown` keeps the error the fault raised. */
const fsFaults = vi.hoisted(() => ({
  cutWrite: null as string | null,
  refuseRename: null as string | null,
  refuseRemove: false,
  renames: 0,
  thrown: null as Error | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fault = (code: string, op: string): Error => {
    const err = Object.assign(new Error(`${code}: simulated failure, ${op}`), { code });
    fsFaults.thrown = err;
    return err;
  };
  const writeFileSync = ((file: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1], options?: Parameters<typeof actual.writeFileSync>[2]) => {
    if (fsFaults.cutWrite !== null && String(file).endsWith(".tmp")) {
      const text = String(data);
      actual.writeFileSync(file, text.slice(0, Math.ceil(text.length / 2)), options);
      throw fault(fsFaults.cutWrite, "write");
    }
    return actual.writeFileSync(file, data, options);
  }) as typeof actual.writeFileSync;
  const renameSync = ((from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
    if (String(from).endsWith(".tmp")) {
      fsFaults.renames += 1;
      if (fsFaults.refuseRename !== null) throw fault(fsFaults.refuseRename, "rename");
    }
    return actual.renameSync(from, to);
  }) as typeof actual.renameSync;
  const rmSync = ((path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
    if (fsFaults.refuseRemove && String(path).endsWith(".tmp")) {
      throw Object.assign(new Error("EBUSY: simulated failure, rm"), { code: "EBUSY" });
    }
    return actual.rmSync(path, options);
  }) as typeof actual.rmSync;
  const patched = { writeFileSync, renameSync, rmSync };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});

import { writeJsonStateFileSync, writeTextStateFileSync } from "../runtime/state-file.js";
import { readNightlyState, ReplayCache, writeNightlyState } from "../harness-lab/replay.js";

let dir: string;
const tempFiles = (where = dir): string[] => readdirSync(where).filter((name) => name.endsWith(".tmp"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "starlingai-state-file-"));
  Object.assign(fsFaults, { cutWrite: null, refuseRename: null, refuseRemove: false, renames: 0, thrown: null });
});

afterEach(() => {
  Object.assign(fsFaults, { cutWrite: null, refuseRename: null, refuseRemove: false });
  rmSync(dir, { recursive: true, force: true });
});

describe("state files: a failed write leaves no temp file", () => {
  it("a write that succeeds replaces the file whole and leaves only the file", () => {
    const file = join(dir, "nested", "accounts.json");
    writeJsonStateFileSync(file, { accounts: ["a"] });
    writeJsonStateFileSync(file, { accounts: ["a", "b"] });
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify({ accounts: ["a", "b"] }, null, 2)}\n`);
    expect(readdirSync(join(dir, "nested"))).toEqual(["accounts.json"]);
  });

  it("a write cut short (a full disk) throws its own error, keeps the previous file and removes the temp file", () => {
    const file = join(dir, "ledger.ndjson");
    writeFileSync(file, '{"previous":true}\n');
    fsFaults.cutWrite = "ENOSPC";

    let caught: unknown;
    try { writeTextStateFileSync(file, '{"next":1}\n{"next":2}\n'); } catch (err) { caught = err; }

    expect(caught).toBeDefined();
    expect(caught).toBe(fsFaults.thrown);
    expect(caught).toMatchObject({ code: "ENOSPC" });
    expect(readFileSync(file, "utf8")).toBe('{"previous":true}\n');
    expect(tempFiles()).toEqual([]);
    expect(fsFaults.renames).toBe(0);
  });

  it("the JSON writer removes the temp file of a write cut short too", () => {
    fsFaults.cutWrite = "ENOSPC";
    expect(() => writeJsonStateFileSync(join(dir, "tombstones.json"), { gone: ["x"] })).toThrow(/ENOSPC/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a rename refused outright throws its own error and removes the temp file", () => {
    const file = join(dir, "accounts.json");
    writeFileSync(file, "before");
    fsFaults.refuseRename = "EXDEV";
    expect(() => writeTextStateFileSync(file, "after")).toThrow(/EXDEV/);
    expect(fsFaults.renames).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("before");
    expect(tempFiles()).toEqual([]);
  });

  it("a rename refused by a Windows sharing error is retried, then throws and removes the temp file", () => {
    const file = join(dir, "accounts.json");
    fsFaults.refuseRename = "EPERM";
    expect(() => writeTextStateFileSync(file, "after")).toThrow(/EPERM/);
    expect(fsFaults.renames).toBe(5);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a temp file that cannot be removed does not hide the write's own error", () => {
    fsFaults.cutWrite = "ENOSPC";
    fsFaults.refuseRemove = true;
    let caught: unknown;
    try { writeTextStateFileSync(join(dir, "accounts.json"), "after"); } catch (err) { caught = err; }
    expect(caught).toBe(fsFaults.thrown);
    expect(caught).toMatchObject({ code: "ENOSPC" });
  });
});

describe("harness lab: a failed write leaves no temp file", () => {
  it("the nightly state survives a write cut short, and its temp file goes", () => {
    writeNightlyState(dir, { lastFinished: "run-1" });
    fsFaults.cutWrite = "ENOSPC";
    expect(() => writeNightlyState(dir, { unfinished: "run-2" })).toThrow(/ENOSPC/);
    expect(readNightlyState(dir)).toEqual({ lastFinished: "run-1" });
    expect(tempFiles()).toEqual([]);
  });

  it("the nightly state's temp file goes when its rename is refused", () => {
    fsFaults.refuseRename = "EPERM";
    expect(() => writeNightlyState(dir, { unfinished: "run-2" })).toThrow(/EPERM/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a replay record cut short is not kept, so the step runs again", async () => {
    let runs = 0;
    const step = async () => { runs += 1; return { reply: `run ${runs}` }; };
    fsFaults.cutWrite = "ENOSPC";
    await expect(new ReplayCache(dir, "fp").through("attempt", "k", step)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(readdirSync(join(dir, "replay"))).toEqual([]);

    fsFaults.cutWrite = null;
    const cache = new ReplayCache(dir, "fp");
    expect(await cache.through("attempt", "k", step)).toEqual({ reply: "run 2" });
    expect(cache.stats).toEqual({ served: 0, recorded: 1 });
    expect(tempFiles(join(dir, "replay"))).toEqual([]);
  });
});
