import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * Best of two for a deliverable at max effort: two runs one after the other, the record decides
 * first, a selector asked in both orders only on a tie, and the winner's files are the ones left in
 * the workspace. Invented content throughout.
 */
const audit = vi.hoisted(() => [] as Array<{ type: string; data: Record<string, unknown> }>);
vi.mock("../audit/logger.js", () => ({
  logAudit: (type: string, data: Record<string, unknown>) => { audit.push({ type, data }); },
  subscribeToAudit: () => () => {},
}));

const { applyWinner, choose, parseSelectorAnswer, runBestOfTwo, runPaths } = await import("../agent/best-of-two.js");

let ws = "";
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "sai-best-of-two-ws-"));
  audit.length = 0;
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const write = (rel: string, body: string) => {
  mkdirSync(dirname(join(ws, rel)), { recursive: true });
  writeFileSync(join(ws, rel), body, "utf8");
};
const read = (rel: string) => readFileSync(join(ws, rel), "utf8");

function result(files: Record<string, string>, over: Partial<SubAgentRunResult["stats"]> = {}, output = "Done."): SubAgentRunResult {
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  return {
    output,
    stats: {
      agentName: "content_writer", sessionId: "s", promptChars: 0, userContentChars: 0, toolCount: 1, toolNames: ["write_file"],
      iterations: 1, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, maxIterations: 5, model: "m", capabilities: [],
      terminalState: "completed", outcome: "success", ...over,
    },
    artifacts: Object.keys(files).map((outputPath) => ({ outputPath })),
  };
}

const pageOk = async () => ({ ok: true, detail: "" });
const never = async (): Promise<"1" | "2" | null> => { throw new Error("the selector must not be asked"); };

describe("the record decides first", () => {
  it("keeps the run whose files hold up, and puts its files back", async () => {
    const runs = [
      () => result({ "generated/report.json": "{\"total\": 41," }),
      () => result({ "generated/report.json": "{\"total\": 42}" }),
    ];
    const kept = await runBestOfTwo({ task: "Write the report as JSON.", agentName: "content_writer", workspacePath: ws, run: async (n) => runs[n - 1]!() }, { checkPage: pageOk, askSelector: never });
    expect(read("generated/report.json")).toBe("{\"total\": 42}");
    expect(kept.stats.usage.totalTokens).toBe(300);
    expect(audit).toContainEqual({ type: "best_of_two_decided", data: expect.objectContaining({ ran: 2, winner: "b", decidedBy: "record" }) });
  });

  it("keeps the first run's files when the second run's page does not work", async () => {
    const runs = [
      () => result({ "generated/site/index.html": "<html><body>Bäckerei Morgenrot</body></html>" }),
      () => result({ "generated/site/index.html": "<html><body><script>broken(</script></body></html>" }),
    ];
    const checkPage = async (_abs: string, rel: string) => ({ ok: !readFileSync(_abs, "utf8").includes("broken("), detail: `${rel}: SyntaxError` });
    await runBestOfTwo({ task: "Build the bakery's page.", agentName: "web_coder", workspacePath: ws, run: async (n) => runs[n - 1]!() }, { checkPage, askSelector: never });
    expect(read("generated/site/index.html")).toContain("Bäckerei Morgenrot");
    expect(audit.at(-1)!.data).toMatchObject({ winner: "a", decidedBy: "record" });
  });

  it("prefers a run that completed and delivered over one that did not", async () => {
    const runs = [
      () => result({}, { outcome: "failure", terminalState: "timeout" }),
      () => result({ "generated/plan.md": "# Plan\n- Step one" }),
    ];
    await runBestOfTwo({ task: "Write the plan.", agentName: "content_writer", workspacePath: ws, run: async (n) => runs[n - 1]!() }, { checkPage: pageOk, askSelector: never });
    expect(read("generated/plan.md")).toContain("Step one");
    expect(audit.at(-1)!.data).toMatchObject({ winner: "b", decidedBy: "record" });
  });
});

describe("on a tie, the selector in both orders", () => {
  it("keeps the run it preferred in both orders, and removes what only the other run wrote", async () => {
    const runs = [
      () => result({ "generated/brief.md": "short brief", "generated/notes-a.md": "only the first run wrote this" }, {}, "Brief A"),
      () => result({ "generated/brief.md": "a fuller brief with every section" }, {}, "Brief B"),
    ];
    // The selector reads "Result 1" and "Result 2"; it prefers whichever holds the fuller brief.
    const askSelector = async (_task: string, first: string) => (first.includes("fuller") ? "1" as const : "2" as const);
    await runBestOfTwo({ task: "Write the brief.", agentName: "content_writer", workspacePath: ws, run: async (n) => runs[n - 1]!() }, { checkPage: pageOk, askSelector });
    expect(read("generated/brief.md")).toBe("a fuller brief with every section");
    expect(existsSync(join(ws, "generated/notes-a.md"))).toBe(false);
    expect(audit.at(-1)!.data).toMatchObject({ winner: "b", decidedBy: "selector" });
  });

  it("keeps the first run, its files restored, when the selector does not agree with itself", async () => {
    const runs = [
      () => result({ "generated/brief.md": "brief one" }),
      () => result({ "generated/brief.md": "brief two", "generated/extra.md": "only the second run wrote this" }),
    ];
    const askSelector = async () => "1" as const;
    await runBestOfTwo({ task: "Write the brief.", agentName: "content_writer", workspacePath: ws, run: async (n) => runs[n - 1]!() }, { checkPage: pageOk, askSelector });
    expect(read("generated/brief.md")).toBe("brief one");
    expect(existsSync(join(ws, "generated/extra.md"))).toBe(false);
    expect(audit.at(-1)!.data).toMatchObject({ winner: "a", decidedBy: "first" });
  });
});

describe("when there is no second run", () => {
  it("runs once when the time left would not cover a second run as long as the first", async () => {
    let clock = 0;
    let calls = 0;
    const run = async () => { calls += 1; clock += 60_000; return result({ "generated/a.md": "a" }); };
    await runBestOfTwo({ task: "t", agentName: "content_writer", workspacePath: ws, deadlineMs: 100_000, run }, { checkPage: pageOk, askSelector: never, now: () => clock });
    expect(calls).toBe(1);
    expect(audit.at(-1)!.data).toMatchObject({ ran: 1, reason: expect.stringMatching(/time left/) });
  });

  it("restores the first run's files when the second run throws", async () => {
    const run = async (n: 1 | 2) => {
      if (n === 1) return result({ "generated/deck.html": "<html>deck one</html>" });
      write("generated/deck.html", "<html>half-written</html>");
      throw new Error("model server gone");
    };
    const kept = await runBestOfTwo({ task: "t", agentName: "content_writer", workspacePath: ws, run }, { checkPage: pageOk, askSelector: never });
    expect(read("generated/deck.html")).toBe("<html>deck one</html>");
    expect(kept.output).toBe("Done.");
  });

  it("stops after the first run when the turn was cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const run = async () => { calls += 1; controller.abort(); return result({ "generated/a.md": "a" }); };
    await runBestOfTwo({ task: "t", agentName: "content_writer", workspacePath: ws, signal: controller.signal, run }, { checkPage: pageOk, askSelector: never });
    expect(calls).toBe(1);
  });
});

describe("pieces", () => {
  it("reads a run's own workspace paths only", () => {
    expect(runPaths({ output: "", stats: {} as never, artifacts: [{ outputPath: "generated/b.md" }, { relativePath: "generated/a.md" }, { outputPath: "/etc/passwd" }, { outputPath: "../x" }, {}] })).toEqual(["generated/a.md", "generated/b.md"]);
  });

  it("reads the selector's answer", () => {
    expect(parseSelectorAnswer("2")).toBe("2");
    expect(parseSelectorAnswer("Result 1 is better.")).toBe("1");
    expect(parseSelectorAnswer("Both are fine.")).toBeNull();
  });

  it("never removes a path outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "sai-best-of-two-outside-"));
    writeFileSync(join(outside, "keep.txt"), "keep", "utf8");
    try {
      applyWinner(ws, { label: "a", result: result({}), paths: [], snapshotRoot: join(ws, "none") }, { label: "b", result: result({}), paths: [`../${outside.split(/[\\/]/).pop()}/keep.txt`], snapshotRoot: join(ws, "none") });
      expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a page check that timed out is no verdict either way", async () => {
    write("generated/a/index.html", "<html>a</html>");
    write("generated/b/index.html", "<html>b</html>");
    const a = { label: "a" as const, result: result({ "generated/a/index.html": "<html>a</html>" }), paths: ["generated/a/index.html"], snapshotRoot: ws };
    const b = { label: "b" as const, result: result({ "generated/b/index.html": "<html>b</html>" }), paths: ["generated/b/index.html"], snapshotRoot: ws };
    // The first run's page timed out (the machine's load, as likely as the page); the selector then decides.
    const checkPage = async (_abs: string, rel: string) => (rel.includes("/a/") ? { ok: false, detail: "timed out", timedOut: true as const } : { ok: true, detail: "" });
    const askSelector = async (_task: string, first: string) => (first.includes("generated/a/") ? "1" as const : "2" as const);
    expect(await choose("t", a, b, { checkPage, askSelector })).toMatchObject({ winner: "a", decidedBy: "selector" });
  });

  it("a selector that fails to answer is no verdict", async () => {
    write("generated/x.md", "x");
    const cand = { label: "a" as const, result: result({ "generated/x.md": "x" }), paths: ["generated/x.md"], snapshotRoot: ws };
    const choice = await choose("t", cand, { ...cand, label: "b" }, { checkPage: pageOk, askSelector: async () => { throw new Error("down"); } });
    expect(choice).toMatchObject({ winner: "a", decidedBy: "first" });
  });
});
