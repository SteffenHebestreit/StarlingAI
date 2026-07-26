import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeArtifacts, probeHtmlStructure } from "../agent/artifact-probes.js";

// Temp workspace, not process.cwd(): vitest runs from packages/core, so rooting
// the fixtures at cwd/tmp wrote into the source tree — and the old afterAll only
// removed the probe-fixtures child, leaving an empty packages/core/tmp/ behind
// after every run. probeArtifacts resolves each `location` against
// `workspacePath`, so the workspace and the fixture dir have to move together.
const WORKSPACE = mkdtempSync(join(tmpdir(), "sai-probe-ws-"));
const ROOT = join(WORKSPACE, "probe-fixtures");

describe("deterministic artifact probes (QA-304)", () => {
  beforeAll(async () => {
    await mkdir(ROOT, { recursive: true });
    await writeFile(resolve(ROOT, "valid.json"), JSON.stringify({ ok: true, items: [1, 2, 3] }));
    await writeFile(resolve(ROOT, "broken.json"), '{"ok": true, "items": [1, 2'); // truncated
    await writeFile(resolve(ROOT, "valid.html"), "<html><body><script>const x = 1;</script><p>hi</p></body></html>");
    await writeFile(resolve(ROOT, "truncated.html"), "<html><body><script>const data = [1,2,3"); // mid-write cut
    await writeFile(resolve(ROOT, "empty.txt"), "");
  });
  afterAll(async () => {
    await rm(WORKSPACE, { recursive: true, force: true });
  });

  it("passes valid JSON and HTML with hash receipts", async () => {
    const report = await probeArtifacts(
      [{ kind: "file", location: "probe-fixtures/valid.json" }, { kind: "file", location: "probe-fixtures/valid.html" }],
      { workspacePath: WORKSPACE },
    );
    expect(report.status).toBe("pass");
    expect(report.receipts.every((r) => r.status === "pass")).toBe(true);
    expect(report.receipts.some((r) => r.probe === "json_parse")).toBe(true);
    expect(report.receipts.some((r) => r.probe === "html_structure")).toBe(true);
    expect(report.receipts.every((r) => !r.contentHash || /^[0-9a-f]{16}$/.test(r.contentHash))).toBe(true);
  });

  it("fails truncated JSON with a parse receipt", async () => {
    const report = await probeArtifacts([{ kind: "file", location: "probe-fixtures/broken.json" }], { workspacePath: WORKSPACE });
    expect(report.status).toBe("fail");
    expect(report.receipts.find((r) => r.probe === "json_parse")?.status).toBe("fail");
  });

  it("fails HTML that ends mid-write (unclosed script) — the classic truncated build", async () => {
    const report = await probeArtifacts([{ kind: "file", location: "probe-fixtures/truncated.html" }], { workspacePath: WORKSPACE });
    expect(report.status).toBe("fail");
    const receipt = report.receipts.find((r) => r.probe === "html_structure");
    expect(receipt?.status).toBe("fail");
    expect(receipt?.detail).toMatch(/unclosed|mid-tag/);
  });

  it("fails zero-byte and missing files", async () => {
    const report = await probeArtifacts(
      [{ kind: "file", location: "probe-fixtures/empty.txt" }, { kind: "file", location: "probe-fixtures/nope.bin" }],
      { workspacePath: WORKSPACE },
    );
    expect(report.status).toBe("fail");
    expect(report.receipts.filter((r) => r.status === "fail")).toHaveLength(2);
  });

  it("fails a dead served URL", async () => {
    const report = await probeArtifacts([{ kind: "url", location: "http://127.0.0.1:59999/api/app/dead/" }], { workspacePath: WORKSPACE });
    expect(report.status).toBe("fail");
    expect(report.receipts[0]?.probe).toBe("served_health");
  }, 15_000);

  it("html structure heuristics stand alone", () => {
    expect(probeHtmlStructure("<html><body></body></html>").ok).toBe(true);
    expect(probeHtmlStructure("<html><body>").ok).toBe(false);
    expect(probeHtmlStructure("text <div").ok).toBe(false);
    expect(probeHtmlStructure("").ok).toBe(false);
  });

  it("no artifacts → not_applicable", async () => {
    expect((await probeArtifacts([], { workspacePath: WORKSPACE })).status).toBe("not_applicable");
  });
});
