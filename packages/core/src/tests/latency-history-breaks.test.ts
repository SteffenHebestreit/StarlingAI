/**
 * N1 of the cache plan: what rewriting a run's history mid-run costs the call after it, from audit
 * rows alone (agent/latency-attribution.ts historyBreakReport, rendered by latency:report).
 *
 * The fixture (fixtures/latency-history-breaks.jsonl) carries the four digests of turn c297c5ea
 * with the real llama.cpp timings of the calls around them — 5.4 s, 18.6 s, 39.6 s and 51.5 s of
 * prompt processing after cached calls of 0.8-1.5 s — plus the cases the join must get right: a
 * digest and a trim on one iteration (one break), a side call of the run that ended just before a
 * digest (not the run's loop call), the orchestrator's own compaction (no timings: TTFT stands in), a
 * run whose digest is its last row, and a digest no turn owns. Every expected number below is
 * worked out from the fixture's rows by hand in the comments.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HISTORY_BREAK_ROW_TYPES,
  attributeLatency,
  buildTurnContexts,
  historyBreakReport,
  parseAuditJsonl,
  renderLatencyMarkdown,
  type AuditRow,
} from "../agent/latency-attribution.js";

const FIXTURE = readFileSync(new URL("./fixtures/latency-history-breaks.jsonl", import.meta.url), "utf8");
const ROOT = "5e551011-0000-4000-8000-00000000c297";

function rows(): AuditRow[] {
  return parseAuditJsonl(FIXTURE).rows;
}

describe("history breaks: each rewrite joined with the call it made expensive", () => {
  it("reads the fixture whole", () => {
    const parsed = parseAuditJsonl(FIXTURE);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.rows).toHaveLength(35);
    expect(HISTORY_BREAK_ROW_TYPES).toEqual(["sub_agent_history_digested", "sub_agent_history_trimmed", "history_compacted"]);
  });

  it("joins each digest with the run's next loop call and prices it against the call before", () => {
    const { turns } = buildTurnContexts(rows());
    const report = historyBreakReport(rows(), turns);
    // Seven break rows: four c297c5ea digests, the trim that shares run B's iteration, the
    // orchestrator's compaction, run D's last-word digest — and one digest no turn owns (left out).
    // The digest+trim pair is one break, so six.
    expect(report.breaks).toHaveLength(6);
    const [a1, a2, b, c, orchestrator, d] = report.breaks;

    // 01:31:18.860, batch: next call 3,912 tokens again (cacheN 9,870) in 5,374.2 ms; the call
    // before it processed 55 tokens in 838.354 ms. Excess 5,374.2 - 838.354 = 4,535.846 -> 4,536.
    expect(a1).toMatchObject({ turn: 1, agentName: "content_writer", trigger: "batch", rowTypes: ["sub_agent_history_digested"], reprefillMs: 5_374, excessMs: 4_536 });
    expect(a1!.next).toMatchObject({ promptN: 3_912, cacheN: 9_870, promptMs: 5_374 });
    expect(a1!.previous).toMatchObject({ promptN: 55, cacheN: 25_697 });
    // 01:36:00.492: 18,606.948 ms after 763.102 -> 18,607 and 17,844.
    expect(a2).toMatchObject({ reprefillMs: 18_607, excessMs: 17_844 });
    // 01:54:38.707 digest + 01:54:38.708 trim, one iteration: one break, both row types, restored
    // at cacheN 7,591 (the end of the head) and 30,269 tokens again. 39,555.671 - 903.051 -> 38,653.
    expect(b).toMatchObject({ rowTypes: ["sub_agent_history_digested", "sub_agent_history_trimmed"], trigger: "overflow", reprefillMs: 39_556, excessMs: 38_653 });
    expect(b!.next).toMatchObject({ promptN: 30_269, cacheN: 7_591 });
    // 02:32:52.909: a no-tool side call of the same run (an async distillation, routing_tier, 950 ms)
    // ended just before the digest; it is not the run's previous LOOP call, the 1,511.01 ms one is.
    // 51,546.92 - 1,511.01 -> 51,547 and 50,036.
    expect(c).toMatchObject({ reprefillMs: 51_547, excessMs: 50_036 });
    expect(c!.previous).toMatchObject({ promptN: 363, cacheN: 45_786 });
    expect(c!.next).toMatchObject({ promptN: 35_399, durationMs: 57_361 });
    // The orchestrator's compaction: its calls carry no timings, so the TTFT stands in: 11,000 after 2,000.
    expect(orchestrator).toMatchObject({ sessionId: ROOT, rowTypes: ["history_compacted"], reprefillMs: 11_000, excessMs: 9_000 });
    expect(orchestrator!.next).toMatchObject({ promptN: null, promptMs: null, ttftMs: 11_000 });
    // Run D's digest is its last row: nothing to price.
    expect(d).toMatchObject({ agentName: "image_sourcer", next: null, reprefillMs: null, excessMs: null });
  });

  it("totals per turn: 126.1 s of re-prefill, 120.1 s of it above the cached calls, 84,319 tokens again", () => {
    const report = attributeLatency(rows()).historyBreaks;
    // 5,374 + 18,607 + 39,556 + 51,547 + 11,000 = 126,084; 4,536 + 17,844 + 38,653 + 50,036 + 9,000 = 120,069;
    // 3,912 + 14,739 + 30,269 + 35,399 = 84,319 (the orchestrator's call has no promptN).
    expect(report.totals).toEqual({
      breaks: 6, turnsAffected: 1, reprefillMs: 126_084, excessMs: 120_069, reprocessedTokens: 84_319, withTimings: 4, withoutNextCall: 1,
    });
    expect(report.perTurn).toEqual([{ turn: 1, sessionId: ROOT, breaks: 6, reprefillMs: 126_084, excessMs: 120_069, reprocessedTokens: 84_319 }]);
  });

  it("renders its own section in latency:report, and says so when there is nothing to report", () => {
    const report = attributeLatency(rows());
    const md = renderLatencyMarkdown(report);
    expect(md).toContain("## Re-prefill after history rewrites");
    expect(md).toContain("**6** break(s) in 1 turn(s): re-prefill 126.1 s, excess 120.1 s, 84319 tokens processed again");
    expect(md).toContain("sub_agent_history_digested, sub_agent_history_trimmed");
    const quiet = renderLatencyMarkdown(attributeLatency(rows().filter((row) => !HISTORY_BREAK_ROW_TYPES.includes(row.type))));
    expect(quiet).toContain("No history rewrite on these turns.");
  });

  it("never prices a break against its own next call, even when that call is over within the join slack", () => {
    // A fast warm call right after the digest (200 ms, ending inside the 250 ms slack) qualifies as
    // "ended by the break" too; taken as the previous call it would price the break against itself.
    const root = "5e551011-0000-4000-8000-0000000000aa";
    const run = `sub:${root}:researcher:1790386000009`;
    const row = (id: number, ts: string, type: string, sessionId: string, data: Record<string, unknown>) =>
      JSON.stringify({ id: `00000000-0000-4000-8000-0000000001${String(id).padStart(2, "0")}`, timestamp: ts, type, sessionId, severity: "info", data });
    const call = (id: number, ts: string, durationMs: number, promptN: number, promptMs: number) => row(id, ts, "provider_model_call", run, {
      agentName: "researcher", callSite: "sub_agent", model: "qwen", mode: "complete", durationMs, promptTokens: promptN + 9_000, completionTokens: 5,
      reasoningTokens: null, reasoningChars: 0, finishReason: "tool_calls", toolCount: 6, messageCount: 9, timings: { promptN, cacheN: 9_000, promptMs, predictedMs: 50 },
    });
    const jsonl = [
      row(1, "2026-09-26T05:00:00.000Z", "message_received", root, { length: 40 }),
      row(2, "2026-09-26T05:00:01.000Z", "sub_agent_started", run, { agentName: "researcher" }),
      call(3, "2026-09-26T05:00:09.900Z", 1_000, 400, 700),
      row(4, "2026-09-26T05:00:10.000Z", "sub_agent_history_digested", run, { agentName: "researcher", digestTrigger: "batch" }),
      call(5, "2026-09-26T05:00:10.200Z", 150, 120, 110),
      row(6, "2026-09-26T05:00:20.000Z", "sub_agent_completed", run, { agentName: "researcher", outcome: "success" }),
      row(7, "2026-09-26T05:00:21.000Z", "message_sent", root, { length: 80 }),
    ].join("\n");
    const parsed = parseAuditJsonl(jsonl).rows;
    const [only] = historyBreakReport(parsed, buildTurnContexts(parsed).turns).breaks;
    expect(only!.next).toMatchObject({ promptN: 120, promptMs: 110 });
    expect(only!.previous).toMatchObject({ promptN: 400, promptMs: 700 });
    expect(only!.excessMs).toBe(0);
  });

  it("does not claim a lever and does not move any lever figure", () => {
    const withBreaks = attributeLatency(rows());
    const without = attributeLatency(rows().filter((row) => !HISTORY_BREAK_ROW_TYPES.includes(row.type)));
    expect(withBreaks.levers).toEqual(without.levers);
    expect(withBreaks.combined).toEqual(without.combined);
  });
});
