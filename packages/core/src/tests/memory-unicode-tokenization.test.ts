import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchMemoryRecords, storeWorkspaceMemoryRecord } from "../memory/service.js";
import { resetSharedMemoryForTests } from "../swarm/memory.js";

/**
 * Memory search tokenized on `[^a-z0-9_]+`, treating every non-ASCII letter as a
 * word separator. "Mängelrüge" became ["ngelr","ge"] and CJK vanished entirely.
 * Because scoreRecord matches tokens by SUBSTRING, the fragments did not merely
 * fail to match — "ngel" matched Mangel/Engel/Klingel, so the bug both lost real
 * hits and manufactured false ones.
 */
describe("memory search — Unicode tokenization", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await resetSharedMemoryForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-unicode-tok-"));
    dirs.push(dir);
    return dir;
  }

  it("finds a German record by an umlaut term", async () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, {
      key: "maengelruege",
      subject: "Mängelrüge an den Bauunternehmer",
      content: "Die Mängelrüge wurde am 3. März versendet.",
      kind: "fact",
    });

    const hits = await searchMemoryRecords(ws, "Mängelrüge", { scopes: ["workspace"] });
    expect(hits.map((r) => r.key)).toContain("maengelruege");
  });

  it("gives an unrelated word no token credit through an umlaut fragment", async () => {
    const ws = workspace();
    // searchMemoryRecords has no relevance floor — every record scores at least
    // scopeWeight + recencyBoost, so presence proves nothing. The bug was a SCORING
    // bug: the ASCII tokenizer split "Mängelrüge" into ["ngelr","ge"], and "ge" is a
    // substring of "Klingel", so an unrelated record collected a +0.28 subject bonus.
    // The assertion is therefore that Klingel scores exactly like a control record
    // that shares nothing with the query.
    storeWorkspaceMemoryRecord(ws, {
      key: "maengelruege",
      subject: "Mängelrüge an den Bauunternehmer",
      content: "Die Mängelrüge wurde am 3. März versendet.",
      kind: "fact",
    });
    storeWorkspaceMemoryRecord(ws, {
      key: "klingel",
      subject: "Klingel am Vordereingang",
      content: "Die Klingel funktioniert wieder.",
      kind: "fact",
    });
    storeWorkspaceMemoryRecord(ws, {
      key: "control",
      subject: "Zahlungsplan",
      content: "Die dritte Rate ist erst nach Abnahme fällig.",
      kind: "fact",
    });

    const hits = await searchMemoryRecords(ws, "Mängelrüge", { scopes: ["workspace"] });
    const score = (key: string) => hits.find((r) => r.key === key)?.score ?? 0;

    expect(hits[0]?.key).toBe("maengelruege");
    expect(score("maengelruege")).toBeGreaterThan(score("klingel"));
    // The precise anti-false-positive claim: Klingel earned no query credit at all.
    expect(score("klingel")).toBeCloseTo(score("control"), 5);
  });

  it("finds a CJK record", async () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, {
      key: "cjk_note",
      subject: "浴室のレイアウト",
      content: "浴室のレイアウトについて何度も伝えました。",
      kind: "fact",
    });

    const hits = await searchMemoryRecords(ws, "浴室", { scopes: ["workspace"] });
    expect(hits.map((r) => r.key)).toContain("cjk_note");
  });

  it("matches across Unicode normalization forms", async () => {
    const ws = workspace();
    // Stored decomposed (a + combining diaeresis), queried composed (ä).
    storeWorkspaceMemoryRecord(ws, {
      key: "decomposed",
      subject: "Bäder und Sanitärobjekte",
      content: "Die Bäder sind falsch geplant.",
      kind: "fact",
    });

    const hits = await searchMemoryRecords(ws, "Bäder", { scopes: ["workspace"] });
    expect(hits.map((r) => r.key)).toContain("decomposed");
  });

  it("still matches plain ASCII terms", async () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, {
      key: "ascii_note",
      subject: "Bathroom layout",
      content: "The bathroom layout was raised repeatedly.",
      kind: "fact",
    });

    const hits = await searchMemoryRecords(ws, "bathroom", { scopes: ["workspace"] });
    expect(hits.map((r) => r.key)).toContain("ascii_note");
  });
});
