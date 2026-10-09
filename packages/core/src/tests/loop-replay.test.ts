/**
 * The loop brake's replay over audit rows (agent/loop-replay.ts, `pnpm loops:replay`): synthetic
 * rows in the shape sub-agent.ts writes them. The rules are the shipped ones; what these pin is the
 * reconstruction around them — iterations, the reset at a write, whose stop a stop is, and that no
 * word from a row reaches the report.
 */
import { describe, expect, it } from "vitest";
import type { AuditRow } from "../agent/latency-attribution.js";
import { renderLoopReplayMarkdown, replayLoopBrake } from "../agent/loop-replay.js";
import { parseLoopsReplayArgs } from "../scripts/loops-replay.js";

const T0 = Date.parse("2026-09-26T01:00:00.000Z");
let rowId = 0;
function row(type: string, sessionId: string, atS: number, data: Record<string, unknown>): AuditRow {
  rowId += 1;
  return { id: `r${rowId}`, timestamp: new Date(T0 + atS * 1000).toISOString(), type, sessionId, data };
}

/** One iteration: the model call that asked for the tools, then their done rows. */
function iteration(session: string, atS: number, calls: Array<{ tool: string; args: Record<string, unknown>; preview: string; cached?: boolean; skipped?: string; outputPath?: string }>): AuditRow[] {
  return [
    row("provider_model_call", session, atS, { callSite: "sub_agent", toolCount: 12, durationMs: 2_000 }),
    ...calls.map((c, i) => row("sub_agent_tool_call", session, atS + 0.1 * (i + 1), {
      agentName: "content_writer",
      tool: c.tool,
      phase: "done",
      toolCallId: `c${rowId}`,
      args: c.args,
      success: c.skipped ? false : true,
      resultPreview: c.preview,
      ...(c.cached ? { cachedResult: true } : {}),
      ...(c.skipped ? { skippedReason: c.skipped } : {}),
      ...(c.outputPath ? { metadata: { outputPath: c.outputPath } } : {}),
    })),
  ];
}

function run(session: string, body: AuditRow[], endS: number, outcome: string): AuditRow[] {
  return [
    row("sub_agent_started", session, 0, { agentName: "content_writer" }),
    ...body,
    row("sub_agent_completed", session, endS, { agentName: "content_writer", outcome }),
  ];
}

const SECRET = "Leuchtturm Roter Sand";
const grep = { tool: "grep_files", args: { pattern: SECRET, path: "deck.html" }, preview: `No matches for /${SECRET}/.` };

describe("loops:replay — the refusal rule over audit rows", () => {
  it("stops a straight loop at its 5th identical call, and not a run that ended in success", () => {
    const loop = "sub:turn-a:content_writer:1";
    const rows = run(loop, Array.from({ length: 10 }, (_, i) => iteration(loop, 10 + i * 5, [{ ...grep, cached: i > 0 }])).flat(), 100, "partial");
    const report = replayLoopBrake(rows);
    const replayed = report.runs[0]!;
    expect(replayed.refusal.firstAt).toMatchObject({ call: 4, tool: "grep_files" });
    expect(replayed.refusal.stopAt).toMatchObject({ call: 5 });
    // Stopped at 30.1 s instead of running to 100 s.
    expect(replayed.savedS).toBeCloseTo(100 - 30.1, 1);
    expect(report.summary).toMatchObject({ runsWithStop: 1, stopsOnSuccess: 0 });
  });

  it("restarts the count at every successful write", () => {
    const s = "sub:turn-b:content_writer:2";
    const write = { tool: "edit_file", args: { path: "deck.html" }, preview: "Edited deck.html.", outputPath: "deck.html" };
    const body = [
      ...iteration(s, 10, [grep]), ...iteration(s, 15, [grep]), ...iteration(s, 20, [grep]),
      ...iteration(s, 25, [write]),
      ...iteration(s, 30, [grep]), ...iteration(s, 35, [grep]), ...iteration(s, 40, [grep]),
    ];
    const replayed = replayLoopBrake(run(s, body, 50, "success")).runs[0]!;
    expect(replayed.refusal.firstAt).toBeNull();
    expect(replayed.refusal.stopAt).toBeNull();
  });

  it("counts the same arguments with a DIFFERENT result as a different call — a cache would have answered the first one", () => {
    const s = "sub:turn-c:content_writer:3";
    const body = Array.from({ length: 6 }, (_, i) => iteration(s, 10 + i * 5, [{ ...grep, preview: `result ${i}` }])).flat();
    expect(replayLoopBrake(run(s, body, 60, "success")).runs[0]!.refusal.firstAt).toBeNull();
  });

  it("leaves a stop the run made itself (two iterations blocked in the log) to the run", () => {
    const s = "sub:turn-d:content_writer:4";
    const capped = { tool: "read_file", args: { path: "x" }, preview: "cap", skipped: "per_tool_failure_cap" };
    const body = [
      ...iteration(s, 10, [capped]),
      ...iteration(s, 15, [capped]),
      row("sub_agent_tool_loop_detected", s, 15.5, { reason: "all_tool_calls_blocked" }),
    ];
    const replayed = replayLoopBrake(run(s, body, 40, "partial")).runs[0]!;
    expect(replayed.refusal.stopAt).toBeNull();
    expect(replayed.realStopS).toBe(15.5);
    expect(replayed.savedS).toBe(0);
  });

  it("answers a non-idempotent tool from the cache only when its last call had the same arguments", () => {
    // verify_page is not idempotent: the shipped loop replays it only when that tool's previous
    // executed call had the same arguments. A,B,A,B executes every call there and is never refused;
    // A,A,A,A,A is replayed, refused and stopped like any loop.
    const s = "sub:turn-h:web_coder:8";
    const page = (path: string) => ({ tool: "verify_page", args: { path }, preview: `FAIL: ${path} line 3` });
    const alternating = Array.from({ length: 10 }, (_, i) => iteration(s, 10 + i * 5, [page(i % 2 === 0 ? "a.html" : "b.html")])).flat();
    expect(replayLoopBrake(run(s, alternating, 70, "partial")).runs[0]!.refusal).toMatchObject({ firstAt: null, stopAt: null, refusals: 0 });
    const t = "sub:turn-i:web_coder:9";
    const straight = Array.from({ length: 6 }, (_, i) => iteration(t, 10 + i * 5, [{ ...page("a.html"), cached: i > 0 }])).flat();
    expect(replayLoopBrake(run(t, straight, 50, "partial")).runs[0]!.refusal).toMatchObject({ firstAt: { call: 4 }, stopAt: { call: 5 } });
  });

  it("an idempotent tool alternating between two calls is the A→B→A cache's loop, and is refused", () => {
    const s = "sub:turn-j:content_writer:10";
    const grepB = { ...grep, args: { pattern: "other", path: "deck.html" }, preview: "No matches for /other/." };
    const body = Array.from({ length: 10 }, (_, i) => iteration(s, 10 + i * 5, [{ ...(i % 2 === 0 ? grep : grepB), cached: i > 1 }])).flat();
    // A,B,A,B,A,B then the 4th A (call 7) is refused, the 4th B (call 8) too: two blocked iterations.
    expect(replayLoopBrake(run(s, body, 70, "partial")).runs[0]!.refusal).toMatchObject({ firstAt: { call: 7 }, stopAt: { call: 8 } });
  });

  it("an iteration of cached failures is blocked, as in the loop: with a refusal before it, that is the brake's stop", () => {
    const s = "sub:turn-k:content_writer:11";
    const failing = { tool: "read_file", args: { path: "missing.md" }, preview: "Error: not found" };
    const body = [
      ...iteration(s, 10, [{ ...failing }]),
      ...iteration(s, 15, [grep]), ...iteration(s, 20, [{ ...grep, cached: true }]), ...iteration(s, 25, [{ ...grep, cached: true }]),
      ...iteration(s, 30, [{ ...grep, cached: true }]), // refused
      ...iteration(s, 35, [{ ...failing, cached: true }]), // a cached failure: blocked
    ].map((r) => (r.data["resultPreview"] === "Error: not found" ? { ...r, data: { ...r.data, success: false } } : r));
    const replayed = replayLoopBrake(run(s, body, 60, "partial")).runs[0]!;
    expect(replayed.refusal.firstAt).toMatchObject({ call: 5 });
    expect(replayed.refusal.stopAt).toMatchObject({ call: 6 });
  });

  it("replays in full once a trim took the earlier answer away", () => {
    const s = "sub:turn-e:content_writer:5";
    const body = [
      ...iteration(s, 10, [grep]), ...iteration(s, 15, [grep]), ...iteration(s, 20, [grep]),
      row("sub_agent_history_trimmed", s, 22, { droppedMessages: 6 }),
      ...iteration(s, 25, [grep]),
    ];
    expect(replayLoopBrake(run(s, body, 30, "partial")).runs[0]!.refusal.firstAt).toBeNull();
  });
});

describe("loops:replay — the busy stall over audit rows", () => {
  it("adds a looping wind-down for a run that wrote a file and then kept asking with nothing new coming back", () => {
    const s = "sub:turn-f:content_writer:6";
    const write = { tool: "edit_file", args: { path: "deck.html" }, preview: "Edited deck.html.", outputPath: "deck.html" };
    // Fresh arguments every call (no cache, no refusal), the same empty answer every time.
    let n = 0;
    const burst = (atS: number) => iteration(s, atS, Array.from({ length: 6 }, () => ({ tool: "grep_files", args: { pattern: `p${++n}` }, preview: "No matches." })));
    const body = [...iteration(s, 10, [write]), ...[60, 200, 260, 400, 460, 600].flatMap(burst)];
    const replayed = replayLoopBrake(run(s, body, 700, "partial")).runs[0]!;
    // As it was: every call succeeded, so every window made "progress".
    expect(replayed.supervisor.before).toBeNull();
    expect(replayed.supervisor.after).toMatchObject({ action: "wind_down", verdict: "looping" });
    expect(replayed.supervisor.brakeWindDownS).toBe(540);
    expect(replayed.refusal.stopAt).toBeNull();
  });
});

describe("loops:replay — the report", () => {
  it("carries ids, names, counts and seconds, and no word from a row", () => {
    const s = "sub:turn-g:content_writer:7";
    const rows = run(s, Array.from({ length: 6 }, (_, i) => iteration(s, 10 + i * 5, [grep])).flat(), 60, "partial");
    const report = replayLoopBrake(rows);
    const markdown = renderLoopReplayMarkdown(report, { files: ["audit.jsonl"], rows: rows.length });
    expect(JSON.stringify(report)).not.toContain("Leuchtturm");
    expect(markdown).not.toContain("Leuchtturm");
    expect(markdown).toContain("| 7 | content_writer | partial |");
  });

  it("takes several audit logs and a session prefix", () => {
    const args = parseLoopsReplayArgs(["--audit", "a.jsonl", "--audit", "/abs/b.jsonl", "--session", "c297c5ea", "--json"], "/repo");
    expect(args.audits).toHaveLength(2);
    expect(args.session).toBe("c297c5ea");
    expect(args.json).toBe(true);
    expect(() => parseLoopsReplayArgs(["--bogus"], "/repo")).toThrow(/unknown argument/);
  });
});
