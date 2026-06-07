import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool, type ToolContext, type ToolHandler } from "../tools/registry.js";
import "../tools/log-stream.js"; // registers log_stream

let ws: string;
let ctx: ToolContext;
beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), "sai-log-"));
  ctx = { workspacePath: ws, sessionId: "log-test" } as unknown as ToolContext;
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}${i === 4 ? " ERROR boom" : ""}`);
  await writeFile(join(ws, "app.log"), lines.join("\n"));
});
afterAll(async () => { await rm(ws, { recursive: true, force: true }); });

const logStream = (): ToolHandler => {
  const h = getTool("log_stream");
  if (!h) throw new Error("log_stream not registered");
  return h;
};

describe("log_stream (file path)", () => {
  it("requires exactly one of serviceName / filePath", async () => {
    expect((await logStream().execute({}, ctx)).success).toBe(false);
    expect((await logStream().execute({ serviceName: "gateway", filePath: "app.log" }, ctx)).success).toBe(false);
  });

  it("rejects an invalid serviceName format before shelling out", async () => {
    const r = await logStream().execute({ serviceName: "bad name; rm -rf" }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("Invalid serviceName");
  });

  it("tails the last N lines of a workspace file", async () => {
    const r = await logStream().execute({ filePath: "app.log", tail: 3 }, ctx);
    expect(r.success).toBe(true);
    const out = r.output.split("\n");
    expect(out).toHaveLength(3);
    expect(out[2]).toBe("line 20");
  });

  it("applies a case-insensitive substring filter", async () => {
    const r = await logStream().execute({ filePath: "app.log", filter: "error" }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain("ERROR boom");
    expect(r.output.split("\n")).toHaveLength(1);
  });

  it("reports a missing file and a path-escape attempt", async () => {
    const missing = await logStream().execute({ filePath: "nope.log" }, ctx);
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("not found");

    const escape = await logStream().execute({ filePath: "../../etc/passwd" }, ctx);
    expect(escape.success).toBe(false);
  });
});
