import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * findBrokenBuiltPages CHECKS THE PAGES TOGETHER (finding 2026-10-05).
 *
 * Each check is a child process, and a staged build runs this before its first model call — up to
 * four pages, one after another. Observed as the number of checks in flight at once.
 */
const flight = vi.hoisted(() => ({ now: 0, max: 0 }));
vi.mock("../tools/page-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/page-check.js")>()),
  checkBuiltPage: async (_abs: string, rel: string) => {
    flight.now += 1;
    flight.max = Math.max(flight.max, flight.now);
    await new Promise((resolve) => setTimeout(resolve, 30));
    flight.now -= 1;
    if (rel.includes("slow")) return { ok: false, detail: `${rel}: the page did not finish within 15s and was stopped`, timedOut: true };
    return rel.includes("bad") ? { ok: false, detail: `${rel}: broken` } : { ok: true, detail: "" };
  },
}));

describe("findBrokenBuiltPages", () => {
  const dir = mkdtempSync(join(tmpdir(), "sai-broken-pages-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("runs the page checks concurrently and still reports every broken one", async () => {
    for (const name of ["a-bad", "b-good", "c-bad"]) {
      mkdirSync(join(dir, "generated", name), { recursive: true });
      writeFileSync(join(dir, "generated", name, "index.html"), "<script>1</script>", "utf8");
    }
    const { findBrokenBuiltPages } = await import("../agent/sub-agent.js");
    const broken = await findBrokenBuiltPages(dir);
    expect(flight.max).toBe(3);
    // Sorted: the walk follows readdir order, which the filesystem decides.
    expect([...broken].sort()).toEqual(["generated/a-bad/index.html: broken", "generated/c-bad/index.html: broken"]);
  });

  it("names each broken page's file beside its verdict, for a caller that reports which file it repaired", async () => {
    const { findBrokenBuiltPageFiles } = await import("../agent/sub-agent.js");
    const broken = await findBrokenBuiltPageFiles(dir);
    expect([...broken].sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: "generated/a-bad/index.html", detail: "generated/a-bad/index.html: broken" },
      { file: "generated/c-bad/index.html", detail: "generated/c-bad/index.html: broken" },
    ]);
  });

  it("says which verdict a timeout produced", async () => {
    const slowDir = mkdtempSync(join(tmpdir(), "sai-slow-pages-"));
    try {
      mkdirSync(join(slowDir, "generated", "d-slow"), { recursive: true });
      writeFileSync(join(slowDir, "generated", "d-slow", "index.html"), "<script>1</script>", "utf8");
      const { findBrokenBuiltPageFiles } = await import("../agent/sub-agent.js");
      expect(await findBrokenBuiltPageFiles(slowDir)).toEqual([
        { file: "generated/d-slow/index.html", detail: "generated/d-slow/index.html: the page did not finish within 15s and was stopped", timedOut: true },
      ]);
    } finally {
      rmSync(slowDir, { recursive: true, force: true });
    }
  });
});
