import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * A BUILT PAGE'S VERDICT IS HELD WHILE ITS BYTES ARE UNCHANGED (finding 2026-10-05).
 *
 * checkBuiltPage runs the page in a child process. A staged build's setup checks the pages (twice:
 * its own, then the conversation's), its end checks them again, and the turn's artifact gate once
 * more — a node start each time for bytes that had not changed. Observed on the child processes
 * actually spawned (the real worker runs).
 */
const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      spawned.count += 1;
      return actual.spawn(...args);
    }) as typeof actual.spawn,
  };
});

const { checkBuiltPage } = await import("../tools/page-check.js");

describe("checkBuiltPage holds its verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "sai-page-verdict-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const page = join(dir, "index.html");
  const script = join(dir, "app.js");

  it("runs an unchanged page once, and again as soon as a script it loads changes", async () => {
    writeFileSync(page, `<html><body><canvas id="c"></canvas><script src="app.js"></script></body></html>`, "utf8");
    writeFileSync(script, "const ready = 1;", "utf8");

    expect(await checkBuiltPage(page, "site/index.html")).toEqual({ ok: true, detail: "" });
    const afterFirst = spawned.count;
    expect(afterFirst).toBeGreaterThan(0);   // the check really ran in a child

    expect(await checkBuiltPage(page, "site/index.html")).toEqual({ ok: true, detail: "" });
    expect(spawned.count).toBe(afterFirst);  // held: no second child for the same bytes

    // The HTML is untouched; the script it loads now fails to parse. A key on the HTML file alone
    // would hand back the held PASS.
    writeFileSync(script, "const ready = 1; const ready = 2;", "utf8");
    const broken = await checkBuiltPage(page, "site/index.html");
    expect(broken.ok).toBe(false);
    expect(spawned.count).toBeGreaterThan(afterFirst);

    // A held FAIL is reported under the label the caller passes.
    const again = await checkBuiltPage(page, "generated/site/index.html");
    expect(again.ok).toBe(false);
    expect(again.detail.startsWith("generated/site/index.html: ")).toBe(true);
  }, 60_000);

  it("re-runs a page whose markup changed though its size and mtime did not", async () => {
    // The inline script is the same in both versions; only the element it asks for is renamed,
    // in the same number of bytes. Keyed on mtime + size + scripts alone, the PASS was handed back.
    const markup = join(dir, "markup.html");
    const page = (id: string) => `<html><body><canvas id="${id}" width="10" height="10"></canvas>`
      + `<script>document.getElementById("c").getContext("2d").fillRect(0, 0, 10, 10);</script></body></html>`;
    const fixed = new Date("2026-10-05T12:00:00Z");
    writeFileSync(markup, page("c"), "utf8");
    utimesSync(markup, fixed, fixed);
    expect((await checkBuiltPage(markup, "site/markup.html")).ok).toBe(true);

    writeFileSync(markup, page("d"), "utf8");
    utimesSync(markup, fixed, fixed);
    expect((await checkBuiltPage(markup, "site/markup.html")).ok).toBe(false);
  }, 60_000);

  it("never holds a timed-out verdict: the next check runs the page again", async () => {
    // A script over the vm's 3 s ceiling can be the machine's load at that moment (up to four
    // checks run at once). Held, one slow run marked the page broken until its bytes changed.
    const slow = join(dir, "slow.html");
    writeFileSync(slow, "<html><body><script>while (true) {}</script></body></html>", "utf8");
    const first = await checkBuiltPage(slow, "site/slow.html");
    expect(first.ok).toBe(false);
    expect(first.detail).toMatch(/timed out/i);
    const afterFirst = spawned.count;

    expect((await checkBuiltPage(slow, "site/slow.html")).ok).toBe(false);
    expect(spawned.count).toBeGreaterThan(afterFirst);   // ran again, not served from the hold
  }, 60_000);
});
