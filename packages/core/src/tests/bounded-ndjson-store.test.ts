/**
 * Tests for the shared bounded NDJSON helper used by the outcomes log and the
 * trajectory cache.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendJsonLine,
  readLastLines,
  readLastRecords,
  trimToLastLines,
} from "../memory/bounded-ndjson-store.js";

describe("bounded-ndjson-store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ndjson-test-"));
    dirs.push(dir);
    return dir;
  }

  it("appendJsonLine creates parent directories and persists JSON records", () => {
    const file = join(mkDir(), "nested/dir/log.ndjson");
    appendJsonLine(file, { a: 1 }, { maxLines: 100 });
    appendJsonLine(file, { a: 2 }, { maxLines: 100 });
    const contents = readFileSync(file, "utf-8").trim().split("\n");
    expect(contents).toHaveLength(2);
    expect(JSON.parse(contents[0]!)).toEqual({ a: 1 });
    expect(JSON.parse(contents[1]!)).toEqual({ a: 2 });
  });

  it("readLastLines returns only the last N lines", () => {
    const file = join(mkDir(), "log.ndjson");
    for (let i = 0; i < 500; i++) {
      appendJsonLine(file, { i }, { maxLines: 10_000, trimCheckInterval: 10_000 });
    }
    const last5 = readLastLines(file, 5);
    expect(last5).toHaveLength(5);
    expect(JSON.parse(last5[0]!)).toEqual({ i: 495 });
    expect(JSON.parse(last5[4]!)).toEqual({ i: 499 });
  });

  it("readLastLines handles files smaller than the chunk size", () => {
    const file = join(mkDir(), "small.ndjson");
    appendJsonLine(file, { id: "a" }, { maxLines: 100 });
    appendJsonLine(file, { id: "b" }, { maxLines: 100 });
    const all = readLastLines(file, 10);
    expect(all).toHaveLength(2);
  });

  it("readLastLines returns [] for missing files", () => {
    const file = join(mkDir(), "missing.ndjson");
    expect(readLastLines(file, 10)).toEqual([]);
  });

  it("readLastLines survives multi-byte UTF-8 across chunk boundaries", () => {
    const file = join(mkDir(), "utf8.ndjson");
    // Write many long German/emoji lines so the tail read must span more
    // than one chunk and land in the middle of multi-byte sequences.
    const payload = "äöüß 🚀🎉 — Zeichenkette";
    const lineBody = payload.repeat(80); // ~1.5 KB of multi-byte text
    for (let i = 0; i < 2_000; i++) {
      appendJsonLine(file, { i, text: lineBody }, { maxLines: 10_000, trimCheckInterval: 10_000 });
    }
    const records = readLastRecords<{ i: number; text: string }>(file, 50);
    expect(records).toHaveLength(50);
    expect(records[records.length - 1]!.i).toBe(1_999);
    // Every returned line must parse and contain the exact expected body —
    // any UTF-8 corruption would break JSON.parse or change the text.
    for (const r of records) {
      expect(r.text).toBe(lineBody);
    }
  });

  it("trimToLastLines caps file growth", () => {
    const file = join(mkDir(), "log.ndjson");
    for (let i = 0; i < 100; i++) {
      appendJsonLine(file, { i }, { maxLines: 10_000, trimCheckInterval: 10_000 });
    }
    trimToLastLines(file, 25);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(25);
    expect(JSON.parse(lines[0]!)).toEqual({ i: 75 });
  });

  it("appendJsonLine auto-trims at the configured interval", () => {
    const file = join(mkDir(), "log.ndjson");
    for (let i = 0; i < 30; i++) {
      // trimCheckInterval 10 + maxLines 5 → every 10th write trims to 5 lines
      appendJsonLine(file, { i }, { maxLines: 5, trimCheckInterval: 10 });
    }
    const lines = readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(15);
  });

  it("readLastRecords skips malformed JSON lines", () => {
    const file = join(mkDir(), "log.ndjson");
    writeFileSync(file, '{"a":1}\nnot json\n{"a":2}\n', "utf-8");
    const records = readLastRecords<{ a: number }>(file, 10);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ a: 1 });
    expect(records[1]).toEqual({ a: 2 });
  });
});
