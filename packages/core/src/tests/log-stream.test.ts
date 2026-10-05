import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool, type ToolContext, type ToolHandler } from "../tools/registry.js";
import "../tools/log-stream.js"; // registers log_stream

// `docker compose logs` stand-in: a 2,000-line service log whose FIRST line holds the only panic,
// honouring --tail the way docker does. Anything that is not docker goes to the real execFile.
const dockerCalls = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const serviceLog = Array.from({ length: 2000 }, (_, i) => (i === 0 ? "gateway-1 | PANIC: lost the queue" : `gateway-1 | ok ${i}`));
  const execFile = ((...args: unknown[]) => (actual.execFile as (...a: unknown[]) => unknown)(...args)) as typeof actual.execFile;
  Object.assign(execFile, {
    [promisify.custom]: async (cmd: string, argv: string[], opts: unknown) => {
      if (cmd !== "docker") return (promisify(actual.execFile) as (...a: unknown[]) => Promise<unknown>)(cmd, argv, opts);
      dockerCalls.push(argv);
      const tail = Number(argv[argv.indexOf("--tail") + 1]);
      return { stdout: serviceLog.slice(-tail).join("\n"), stderr: "" };
    },
  });
  return { ...actual, execFile, default: { ...actual, execFile } };
});

let ws: string;
let ctx: ToolContext;
beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), "sai-log-"));
  ctx = { workspacePath: ws, sessionId: "log-test" } as unknown as ToolContext;
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}${i === 4 ? " ERROR boom" : ""}`);
  await writeFile(join(ws, "app.log"), lines.join("\n"));
  // 600 KB: the one FATAL line sits before the 512 KB an unfiltered tail reads.
  const filler = Array.from({ length: 10_000 }, (_, i) => `${String(i).padStart(6, "0")} ${"x".repeat(53)}`);
  await writeFile(join(ws, "big.log"), ["FATAL first boot failed", ...filler].join("\n"));
  await writeFile(join(ws, ".env"), "SAI_JWT_SECRET=supersecret\n");
  await mkdir(join(ws, ".git", "logs"), { recursive: true });
  await writeFile(join(ws, ".git", "logs", "HEAD"), "0000 1111 secret-commit-log\n");
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
    const [shown, window] = r.output.split("\n\n");
    const out = shown!.split("\n");
    expect(out).toHaveLength(3);
    expect(out[2]).toBe("line 20");
    expect(window).toBe("[log_stream: showing the last 3 line(s) of the whole of app.log (20 lines)]");
  });

  it("applies a case-insensitive substring filter", async () => {
    const r = await logStream().execute({ filePath: "app.log", filter: "error" }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain("ERROR boom");
    expect(r.output.split("\n\n")[0]!.split("\n")).toHaveLength(1);
  });

  it("reports a missing file and a path-escape attempt", async () => {
    const missing = await logStream().execute({ filePath: "nope.log" }, ctx);
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("not found");

    const escape = await logStream().execute({ filePath: "../../etc/passwd" }, ctx);
    expect(escape.success).toBe(false);
  });
});

/**
 * "(no log lines matched)" read as "this never happened" — while the filter had only looked at the
 * last `tail` container lines or the last 512 KB of a file. A filter now searches a deeper window,
 * and every answer names the window it searched.
 */
describe("log_stream says which window it searched", () => {
  it("finds a filtered line in a file before the unfiltered tail window, and names the window", async () => {
    const r = await logStream().execute({ filePath: "big.log", filter: "fatal", tail: 5 }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain("FATAL first boot failed");
    expect(r.output).toMatch(/\[log_stream: 1 line\(s\) matching "fatal" in the whole of big\.log \(10001 lines\)\]$/);
  });

  it("says how much of a large file an unfiltered tail did not read", async () => {
    const r = await logStream().execute({ filePath: "big.log", tail: 2 }, ctx);
    expect(r.output).toMatch(/\[log_stream: showing the last 2 line\(s\) of the last 512 KB of big\.log \(\d+ lines; the first \d+ KB of the \d+ KB file were not searched\)\]$/);
  });

  it("filters a container log over a deep window, then tails the matches", async () => {
    dockerCalls.length = 0;
    const r = await logStream().execute({ serviceName: "gateway", filter: "panic", tail: 5 }, ctx);
    expect(r.success).toBe(true);
    expect(dockerCalls[0]).toEqual(["compose", "logs", "--no-color", "--tail", "10000", "gateway"]);
    expect(r.output).toContain("PANIC: lost the queue");
    expect(r.output).toMatch(/\[log_stream: 1 line\(s\) matching "panic" in all 2000 line\(s\) of gateway's log\]$/);
  });

  it("refuses a protected path, as read_file does", async () => {
    for (const filePath of [".env", ".git/logs/HEAD"]) {
      const r = await logStream().execute({ filePath }, ctx);
      expect(r.success, filePath).toBe(false);
      expect(r.output).not.toMatch(/supersecret|secret-commit-log/);
    }
  });
});
