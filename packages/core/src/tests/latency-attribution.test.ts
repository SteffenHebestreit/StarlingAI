/**
 * The offline latency attribution (agent/latency-attribution.ts) on real audit rows: session
 * 6ece6f2a, four image turns from 2026-09-25, scrubbed of every user and model text
 * (fixtures/latency-audit-sample.jsonl). Every expected number below is derived by hand from the
 * fixture's row timestamps and durations, not read back from the module — the comments show how.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LATENCY_PARAMS,
  LEVERS,
  attributeLatency,
  buildTurnContexts,
  dedupeRows,
  estimateCall,
  leverSavingMs,
  parseAuditJsonl,
  readServerTimings,
  renderLatencyMarkdown,
  rootSessionId,
  weightedOverlapMs,
  weightedUnionMs,
  type AuditRow,
  type LatencyParams,
  type LeverClaim,
  type LeverId,
} from "../agent/latency-attribution.js";
import { parseLatencyReportArgs } from "../scripts/latency-report.js";

const FIXTURE_TEXT = readFileSync(new URL("./fixtures/latency-audit-sample.jsonl", import.meta.url), "utf8");
const SESSION = "6ece6f2a-5122-43d3-9a29-87c0daf121a6";

function fixtureRows(): AuditRow[] {
  return parseAuditJsonl(FIXTURE_TEXT).rows;
}

/** A deep copy the test may edit. */
function editableRows(): AuditRow[] {
  return JSON.parse(JSON.stringify(fixtureRows())) as AuditRow[];
}

function rowAt(rows: AuditRow[], type: string, timestamp: string): AuditRow {
  const row = rows.find((r) => r.type === type && r.timestamp === timestamp);
  if (!row) throw new Error(`fixture row ${type} @ ${timestamp} missing`);
  return row;
}

function leverColumn(rows: AuditRow[], lever: LeverId, params: Partial<LatencyParams> = {}): number[] {
  return attributeLatency(rows, params).turns.map((turn) => turn.levers[lever]);
}

describe("parsing the audit log", () => {
  it("reads every fixture row and skips the // comment header", () => {
    const parsed = parseAuditJsonl(FIXTURE_TEXT);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.rows).toHaveLength(156);
    expect(parsed.rows.every((row) => typeof row.id === "string" && typeof row.data === "object")).toBe(true);
  });

  it("counts lines that are not rows instead of throwing, and drops repeated ids", () => {
    const [a, b] = fixtureRows();
    const text = [
      "// header",
      JSON.stringify(a),
      "{not json",
      JSON.stringify({ id: "x", timestamp: "2026-09-25T19:00:00.000Z", data: {} }), // no type
      JSON.stringify(b),
      JSON.stringify(a),
      "",
    ].join("\n");
    const parsed = parseAuditJsonl(text);
    expect(parsed.malformedLines).toBe(2);
    const deduped = dedupeRows(parsed.rows);
    expect(deduped.duplicates).toBe(1);
    expect(deduped.rows.map((row) => row.id)).toEqual([a!.id, b!.id]);
  });
});

describe("turn grouping", () => {
  it("finds the four turns of the session, not one per message_received row", () => {
    const report = attributeLatency(fixtureRows());
    // Each turn writes message_received twice (arrival, then the receptionist's verdict).
    expect(fixtureRows().filter((row) => row.type === "message_received")).toHaveLength(8);
    expect(report.scope.turns).toBe(4);
    expect(report.scope.sessions).toBe(1);
    expect(report.turns.every((turn) => turn.sessionId === SESSION && turn.ended === "message_sent")).toBe(true);
    // message_sent − first message_received: 19:18:34.049 − 19:17:33.751, 19:19:22.943 − 19:18:56.067,
    // 19:29:18.596 − 19:20:42.153, 20:13:15.557 − 20:03:43.899.
    expect(report.turns.map((turn) => turn.wallMs)).toEqual([60_298, 26_876, 516_443, 571_658]);
    expect(report.turns.map((turn) => turn.messageChars)).toEqual([63, 96, 8, 40]);
  });

  it("puts sub-agent rows into their parent's open turn and session-less rows into none", () => {
    const report = attributeLatency(fixtureRows());
    // t1: receptionist, judge, 3 orchestrator, 2 image_creator; t2: judge, 2 orchestrator, 1 image_creator;
    // t3: receptionist, judge, 2 orchestrator, 3 image_creator, synthesis;
    // t4: receptionist, judge, 3 orchestrator, 5 image_creator, 2 qa_verdict, qa_improve.
    expect(report.turns.map((turn) => turn.llm.calls)).toEqual([7, 4, 8, 13]);
    expect(report.turns.map((turn) => turn.timeline.filter((e) => e.kind === "model_call" && e.level === "sub").length)).toEqual([2, 1, 3, 5]);
    // The five cache warm-keeper calls carry no session.
    expect(report.totals.offTurnCalls).toBe(5);
    expect(report.scope.subAgents).toEqual([{ agentName: "image_creator", runs: 4 }]);
  });

  it("separates rendering and the human settings dialog from the rest of the turn", () => {
    const t3 = attributeLatency(fixtureRows()).turns[2]!;
    // generate_image 19:21:38.038 → 19:28:55.510 = 437,472 ms, of which the user spent 22,203 ms in the dialog.
    expect(t3.humanWaitMs).toBe(22_203);
    expect(t3.renderMs).toBe(437_472 - 22_203);
    expect(t3.nonRenderMs).toBe(516_443 - 415_269 - 22_203);
  });

  it("ends a turn without a reply row at its last row", () => {
    const rows = editableRows().filter((row) => !(row.type === "message_sent" && row.timestamp === "2026-09-25T19:19:22.943Z"));
    const t2 = attributeLatency(rows).turns[1]!;
    expect(t2.ended).toBe("no_message_sent");
    // Last row before turn 3 opens: evidence_migration_parity at 19:19:22.954.
    expect(t2.wallMs).toBe(26_887);
  });

  it("keeps a turn the front desk answered in one piece and ends it at the verdict row", () => {
    const FRONT_DESK = "f0f0f0f0-0000-4000-8000-000000000001";
    const rows = [
      ...fixtureRows(),
      { id: "fd-1", timestamp: "2026-09-25T21:00:00.000Z", type: "message_received", sessionId: FRONT_DESK, data: { length: 2 } },
      {
        id: "fd-2", timestamp: "2026-09-25T21:00:01.500Z", type: "provider_model_call", sessionId: FRONT_DESK,
        data: { callSite: "routing_tier", agentName: "receptionist", mode: "complete", durationMs: 1_400, promptTokens: 380, completionTokens: 12, toolCount: 0 },
      },
      // turn-prepare.ts on a hit: the verdict and the reply's length in one row, and no message_sent after it.
      { id: "fd-3", timestamp: "2026-09-25T21:00:01.502Z", type: "message_received", sessionId: FRONT_DESK, data: { fastLane: true, length: 33 } },
      { id: "fd-4", timestamp: "2026-09-25T21:00:01.503Z", type: "turn_scorecard", sessionId: FRONT_DESK, data: {} },
      { id: "fd-5", timestamp: "2026-09-25T21:05:00.000Z", type: "session_updated", sessionId: FRONT_DESK, data: {} },
    ] satisfies AuditRow[];
    const report = attributeLatency(rows);
    expect(report.scope.turns).toBe(5);
    expect(report.scope.leftOut.turns).toBe(0);
    const frontDesk = report.turns.find((turn) => turn.sessionId === FRONT_DESK)!;
    expect(frontDesk).toMatchObject({ ended: "fast_lane_reply", fastLane: true, messageChars: 2, wallMs: 1_502, preOrchestrator: null, combinedMs: 0 });
    expect(frontDesk.levers.laya_gate_calls).toBe(0);
    expect(report.decisionPoints.find((point) => point.point === "fast_lane")).toMatchObject({ calls: 4, claimable: 3 });
    expect(report.scope.turnsWithoutMessageSent).toBe(0);
  });

  it("keeps sessions whose ids carry colons apart, and finds the top of a nested sub-agent", () => {
    expect(rootSessionId("sub:mcp:caller:abc:image_creator:1727")).toBe("mcp:caller:abc");
    expect(rootSessionId("sub:sub:mcp:caller:abc:coder:1:researcher:2")).toBe("mcp:caller:abc");
    expect(rootSessionId(`sub:${SESSION}:image_creator:17903`)).toBe(SESSION);
    expect(rootSessionId(SESSION)).toBe(SESSION);
    // A workflow's own session, and its sub-agents' (tools/workflow-catalog.ts), belong to the turn that ran it.
    expect(rootSessionId(`workflow:${SESSION}:sourced_presentation:c3634964-9fc1`)).toBe(SESSION);
    expect(rootSessionId(`sub:workflow:${SESSION}:sourced_presentation:c3634964-9fc1:researcher:17903`)).toBe(SESSION);
    const MCP = `mcp:caller:${SESSION}`;
    const rows = editableRows().map((row) => (row.sessionId ? { ...row, sessionId: row.sessionId.replace(SESSION, MCP) } : row));
    // Another MCP session's message arrives in the middle of turn 1.
    rows.push({ id: "other-mcp", timestamp: "2026-09-25T19:17:50.000Z", type: "message_received", sessionId: "mcp:caller:other", data: { length: 5 } });
    const report = attributeLatency(rows);
    expect(report.turns.map((turn) => turn.wallMs)).toEqual([60_298, 26_876, 516_443, 571_658]);
    expect(report.turns.every((turn) => turn.sessionId === MCP)).toBe(true);
    expect(report.turns.map((turn) => turn.combinedMs)).toEqual(attributeLatency(fixtureRows()).turns.map((turn) => turn.combinedMs));
    expect(report.scope.leftOut).toMatchObject({ turns: 1, sessions: ["mcp:caller:other"] });
  });

  it("counts a workflow's sub-agents in the turn that ran it, and not the workflow tool as a leaf", () => {
    const WORKFLOW = `workflow:${SESSION}:sourced_presentation:c3634964-9fc1`;
    const rows = editableRows().map((row) => (row.sessionId?.startsWith(`sub:${SESSION}:`)
      ? { ...row, sessionId: row.sessionId.replace(`sub:${SESSION}:`, `sub:${WORKFLOW}:`) }
      : row));
    const plain = attributeLatency(fixtureRows());
    const viaWorkflow = attributeLatency(rows);
    expect(viaWorkflow.turns.map((turn) => turn.timeline.filter((entry) => entry.kind === "sub_agent").length))
      .toEqual(plain.turns.map((turn) => turn.timeline.filter((entry) => entry.kind === "sub_agent").length));
    expect(viaWorkflow.totals.llmCalls).toBe(plain.totals.llmCalls);
    // The tool that ran them holds their time: it is no leaf.
    expect(viaWorkflow.tools.map((stat) => stat.tool)).toEqual(plain.tools.map((stat) => stat.tool));
    expect(plain.tools.map((stat) => stat.tool)).not.toContain("delegate_to_agent");
    expect(plain.tools.map((stat) => stat.tool)).not.toContain("execute_plan");
    expect(plain.tools.map((stat) => stat.tool)).toEqual(expect.arrayContaining(["search_agents", "analyze_image"]));
  });

  it("leaves a turn without any model-call row out of every figure and says so", () => {
    const t2Start = Date.parse("2026-09-25T19:18:56.067Z");
    const t3Start = Date.parse("2026-09-25T19:20:42.153Z");
    const rows = fixtureRows().filter((row) => {
      const at = Date.parse(row.timestamp);
      return !(row.type === "provider_model_call" && row.sessionId && at > t2Start && at < t3Start);
    });
    const report = attributeLatency(rows);
    expect(report.scope.turns).toBe(3);
    expect(report.scope.leftOut).toEqual({ turns: 1, sessions: [SESSION], reason: "no model-call row in the turn" });
    expect(report.totals.wallMs).toBe(60_298 + 516_443 + 571_658);
  });
});

describe("the critical path before the first orchestrator call", () => {
  it("measures message arrival to the first orchestrator call and names what filled it", () => {
    const t1 = attributeLatency(fixtureRows()).turns[0]!;
    // First orchestrator call ends 19:17:45.479 after 4,864 ms → starts 19:17:40.615; the message came at 19:17:33.751.
    expect(t1.preOrchestrator).toEqual({
      totalMs: 6_864,
      routingTierMs: 1_844 + 1_973, // receptionist + source judge, serial
      phasesMs: { discoveryPrefetch: 2_543, documentRag: 5 },
      restMs: 6_864 - 3_817 - 2_548,
      firstOrchestratorTtftMs: 3_040,
      toFirstOrchestratorTokenMs: 6_864 + 3_040,
    });
  });

  it("gives the time to the orchestrator's first token for every turn", () => {
    // The same four figures map-timing.json derived independently for 6ece6f2a.
    expect(attributeLatency(fixtureRows()).turns.map((turn) => turn.preOrchestrator?.toFirstOrchestratorTokenMs)).toEqual([9_904, 5_898, 8_121, 8_607]);
  });

  it("counts a judge running beside the receptionist once, not twice", () => {
    const rows = editableRows();
    // The judge moved to end at 19:17:36.000 (1,973 ms → from 19:17:34.027), overlapping the
    // receptionist (19:17:33.758 → 19:17:35.602): together 19:17:33.758 → 19:17:36.000.
    rowAt(rows, "provider_model_call", "2026-09-25T19:17:37.576Z").timestamp = "2026-09-25T19:17:36.000Z";
    const t1 = attributeLatency(rows).turns[0]!;
    expect(t1.preOrchestrator?.routingTierMs).toBe(2_242);
    // Laya's 20 ms is charged per call: 19:17:33.778 → 19:17:36.000.
    expect(t1.levers.laya_gate_calls).toBe(2_222);
  });

  it("counts an older build's receptionist, stamped main/main_turn without tools, as the receptionist", () => {
    const rows = editableRows();
    const receptionist = rowAt(rows, "provider_model_call", "2026-09-25T19:17:35.602Z");
    receptionist.data["agentName"] = "main";
    receptionist.data["callSite"] = "main_turn";
    const report = attributeLatency(rows);
    const t1 = report.turns[0]!;
    expect(t1.preOrchestrator?.totalMs).toBe(6_864);
    expect(t1.preOrchestrator?.routingTierMs).toBe(3_817);
    expect(t1.levers.laya_gate_calls).toBe(3_777);
    expect(t1.timeline.find((entry) => entry.relabelled)?.label).toBe("receptionist");
    expect(report.totals.relabelledCalls).toBe(1);
  });
});

describe("splitting a call into prefill, decode and overhead", () => {
  it("uses the time to first token for a stream call and classes a cold first sub-agent call as cold", () => {
    const call = attributeLatency(fixtureRows()).turns[0]!.timeline.find((entry) => entry.kind === "model_call" && entry.level === "sub")!;
    // image_creator's first call: 10,192 ms, TTFT 7,067 ms at 6,368 prompt tokens (a full prefill at 900 tok/s ≈ 7,076 ms).
    expect(call).toMatchObject({ basis: "ttft", prefillMs: 7_067, decodeMs: 10_192 - 7_067, prefillClass: "cold" });
  });

  it("uses completion tokens at the decode rate for a complete call, and will not class a small prompt", () => {
    const judge = attributeLatency(fixtureRows()).turns[0]!.timeline.find((entry) => entry.label === "source_sensitivity_judge")!;
    // 1,973 ms, 6 completion tokens at 56 tok/s ≈ 107 ms of decode; 528 prompt tokens are below the 1,500-token floor.
    expect(judge).toMatchObject({ basis: "decode_rate", decodeMs: 107, prefillMs: 1_973 - 107, prefillClass: "indeterminate" });
  });

  it("classes every orchestrator call of the session as a partial re-prefill of a cached head", () => {
    const orchestrator = attributeLatency(fixtureRows()).turns.flatMap((turn) => turn.timeline.filter((entry) => entry.label === "orchestrator"));
    expect(orchestrator).toHaveLength(10);
    expect(new Set(orchestrator.map((entry) => entry.prefillClass))).toEqual(new Set(["partial"]));
  });

  it("uses llama.cpp timings when the row carries them, in either spelling", () => {
    expect(readServerTimings({ timings: { prompt_n: 400, cache_n: 13_000, prompt_ms: 600, predicted_ms: 2_000 } }))
      .toEqual({ promptN: 400, cacheN: 13_000, promptMs: 600, predictedMs: 2_000 });
    expect(readServerTimings({ promptN: 12, cacheN: 0, promptMs: 30, predictedMs: 40 })).toEqual({ promptN: 12, cacheN: 0, promptMs: 30, predictedMs: 40 });
    expect(readServerTimings({ promptTokens: 400 })).toBeNull();
    const params = { ...DEFAULT_LATENCY_PARAMS };
    const warm = estimateCall({ durationMs: 3_000, ttftMs: 700, promptTokens: 13_400, completionTokens: 100, timings: { promptN: 400, cacheN: 13_000, promptMs: 600, predictedMs: 2_000 } }, params);
    expect(warm).toEqual({ prefillMs: 600, decodeMs: 2_000, overheadMs: 400, basis: "timings", prefillClass: "warm" });
    const cold = estimateCall({ durationMs: 1_000, ttftMs: null, promptTokens: 380, completionTokens: 6, timings: { promptN: 380, cacheN: 0, promptMs: 420, predictedMs: 110 } }, params);
    // With timings a small prompt is no longer indeterminate: the server says what it processed.
    expect(cold.prefillClass).toBe("cold");
    expect(cold.overheadMs).toBe(470);
  });

  it("carries timings from a provider row into the timeline", () => {
    const rows = editableRows();
    rowAt(rows, "provider_model_call", "2026-09-25T19:17:37.576Z").data["timings"] = { promptN: 520, cacheN: 8, promptMs: 610, predictedMs: 95 };
    const judge = attributeLatency(rows).turns[0]!.timeline.find((entry) => entry.label === "source_sensitivity_judge")!;
    expect(judge).toMatchObject({ basis: "timings", prefillMs: 610, decodeMs: 95, overheadMs: 1_973 - 705, prefillClass: "cold" });
    expect(attributeLatency(rows).totals.llmWithTimings).toBe(1);
  });
});

describe("levers", () => {
  it("laya_gate_calls: every serial judge call, less Laya's own 20 ms", () => {
    // t1 receptionist 1,844 + judge 1,973; t2 judge 1,819; t3 2,164 + 1,179; t4 1,863 + 1,187 — each − 20.
    expect(leverColumn(fixtureRows(), "laya_gate_calls")).toEqual([3_777, 1_799, 3_303, 3_010]);
    expect(leverColumn(fixtureRows(), "laya_gate_calls", { layaMs: 0 })[0]).toBe(3_817);
  });

  it("laya_gate_calls: a receptionist that answered the message itself is not Laya's to take", () => {
    const rows = editableRows();
    // A hit's verdict row as turn-prepare.ts writes it: the reply's length rides along.
    rowAt(rows, "message_received", "2026-09-25T19:17:35.602Z").data = { fastLane: true, length: 42 };
    expect(attributeLatency(rows).scope.turns).toBe(4);
    expect(leverColumn(rows, "laya_gate_calls")[0]).toBe(1_953);
  });

  it("pre_router_dispatch: from the first orchestrator call to the single dispatch, gate calls excluded", () => {
    // t1: 19:17:40.615 + 20 ms → delegate_to_agent starts 19:18:28.904 − 23,436 = 19:18:05.468.
    // t2: 19:18:58.744 + 20 → 19:19:07.759. t3: 19:20:46.340 + 20 → 19:20:57.423.
    // t4 (one-step plan): 20:03:47.823 + 20 → execute_plan starts 20:12:48.268 − 522,589 = 20:04:05.679.
    expect(leverColumn(fixtureRows(), "pre_router_dispatch")).toEqual([24_833, 8_995, 11_063, 17_836]);
  });

  it("pre_router_dispatch: not when other work ran before the dispatch, nor for a plan of several steps", () => {
    const rows = editableRows();
    rowAt(rows, "tool_call_completed", "2026-09-25T19:18:00.900Z").data["tool"] = "web_search";
    rowAt(rows, "flow_plan_recorded", "2026-09-25T20:04:00.328Z").data["stepCount"] = 2;
    const report = attributeLatency(rows);
    expect(report.turns.map((turn) => turn.levers.pre_router_dispatch)).toEqual([0, 8_995, 11_063, 0]);
    expect(report.turns[0]!.dispatch).toMatchObject({ single: true, toolsBefore: ["web_search"], preRoutable: false });
    // The plan round is still a round, however many steps the plan has.
    expect(report.turns[3]!.levers.plan_round_fold).toBe(5_356);
  });

  it("plan_round_fold: the round after a response that only recorded a plan", () => {
    // Call that recorded it ends 20:04:00.259; the next orchestrator call ends 20:04:05.615.
    expect(leverColumn(fixtureRows(), "plan_round_fold")).toEqual([0, 0, 0, 5_356]);
  });

  it("plan_round_fold: not when the planning response also asked for other work", () => {
    const rows = editableRows();
    rows.push({ id: "extra-request", timestamp: "2026-09-25T20:04:00.320Z", type: "tool_call_requested", sessionId: SESSION, data: { tool: "web_search", args: {} } });
    expect(leverColumn(rows, "plan_round_fold")).toEqual([0, 0, 0, 0]);
  });

  it("subagent_prewarm: only a cold first call, and only its prefill above the warm TTFT", () => {
    // t1's first image_creator call: TTFT 7,067 − 1,500. The first calls of t2–t4 were not cold.
    expect(leverColumn(fixtureRows(), "subagent_prewarm")).toEqual([5_567, 0, 0, 0]);
  });

  it("prefix_cache_kept: nothing on turns whose prefixes stayed cached", () => {
    // Every orchestrator call of the session re-prefilled only its tail; the one cold sub-agent call is a first call.
    expect(leverColumn(fixtureRows(), "prefix_cache_kept")).toEqual([0, 0, 0, 0]);
  });

  it("prefix_cache_kept: a cold orchestrator call and a sub-agent's later cold call, not the run's side calls", () => {
    const rows = editableRows();
    // t1's second orchestrator call went cold (a changed tool list): 14 s to its first token, 2.5 s is warm.
    Object.assign(rowAt(rows, "provider_model_call", "2026-09-25T19:18:05.464Z").data, { ttftMs: 14_000, durationMs: 16_000 });
    // image_creator's second call lost its cache: 7 s against a warm 1.5 s.
    Object.assign(rowAt(rows, "provider_model_call", "2026-09-25T19:18:28.885Z").data, { ttftMs: 7_000, durationMs: 9_000 });
    // A side call of the same run (a distillation: no tools, its own prompt) is cold by nature, and not a lost cache.
    rows.push({
      id: "side-call",
      timestamp: "2026-09-25T19:18:31.000Z",
      type: "provider_model_call",
      sessionId: `sub:${SESSION}:image_creator:1790363885538`,
      data: { agentName: "image_creator", callSite: "sub_agent", mode: "complete", durationMs: 3_000, promptTokens: 2_000, completionTokens: 10, toolCount: 0 },
    });
    expect(leverColumn(rows, "prefix_cache_kept")).toEqual([(14_000 - 2_500) + (7_000 - 1_500), 0, 0, 0]);
  });

  it("agent_search_wait: search_agents above a warm reranker's 3.7 s", () => {
    expect(leverColumn(fixtureRows(), "agent_search_wait")).toEqual([15_418 - 3_700, 0, 0, 0]);
  });

  it("qa_verdict_candidate: only the verdict that passed; the one an improve call followed failed", () => {
    // t4: qa_verdict 4,405 ms → qa_improve → qa_verdict 3,168 ms (pass). Only the second is claimed.
    expect(leverColumn(fixtureRows(), "qa_verdict_candidate")).toEqual([0, 0, 0, 3_168 - 20]);
  });

  it("vision_structuring: nothing without vision rows, the decode above a short answer with them", () => {
    const report = attributeLatency(fixtureRows());
    expect(report.levers.find((lever) => lever.id === "vision_structuring")?.totalMs).toBe(0);
    // The three analyze_image calls (25.2 + 22.0 + 12.8 s) have no model-call row: named, not claimed.
    expect(report.totals.unattributedVision).toEqual({ calls: 3, ms: 25_193 + 22_039 + 12_820 });
    const rows = editableRows();
    rows.push({
      id: "vision-1",
      timestamp: "2026-09-25T19:21:28.500Z",
      type: "provider_model_call",
      sessionId: `sub:${SESSION}:image_creator:17903`,
      data: { callSite: "vision", agentName: "image_creator", mode: "complete", durationMs: 25_000, promptTokens: 1_200, completionTokens: 1_120 },
    });
    // Decode 1,120 tok / 56 tok/s = 20,000 ms; a 64-token answer decodes in ~1,143 ms.
    expect(leverColumn(rows, "vision_structuring")[2]).toBe(20_000 - Math.round((64 / 56) * 1_000));
    // That row lies inside the first analyze_image run (19:21:03.350 → 19:21:28.543); the other two stay unattributed.
    expect(attributeLatency(rows).totals.unattributedVision).toEqual({ calls: 2, ms: 22_039 + 12_820 });
  });

  it("loop_brake: nothing without loop rows; a run's time from its FIRST loop row to its end with them", () => {
    expect(leverColumn(fixtureRows(), "loop_brake")).toEqual([0, 0, 0, 0]);
    const rows = editableRows();
    const run = `sub:${SESSION}:image_creator:1790363885538`; // t1's run: 19:18:05.545 → 19:18:28.886
    rows.push(
      { id: "loop-1", timestamp: "2026-09-25T19:18:10.000Z", type: "sub_agent_tool_loop_detected", sessionId: run, data: { reason: "identical_args_repeat", tool: "read_file" } },
      // A later row of the same run changes nothing: the brake would have acted at the first.
      { id: "loop-2", timestamp: "2026-09-25T19:18:20.000Z", type: "sub_agent_tool_loop_enforced", sessionId: run, data: { action: "refuse", tool: "read_file" } },
      // Not a sub-agent run's row, and a row after t3's run had ended: neither is claimed.
      { id: "loop-3", timestamp: "2026-09-25T19:21:00.000Z", type: "sub_agent_tool_loop_detected", sessionId: SESSION, data: {} },
      { id: "loop-4", timestamp: "2026-09-25T19:29:05.000Z", type: "sub_agent_tool_loop_enforced", sessionId: `sub:${SESSION}:image_creator:1790364057447`, data: {} },
    );
    // 19:18:28.886 − 19:18:10.000.
    expect(leverColumn(rows, "loop_brake")).toEqual([18_886, 0, 0, 0]);
    // The enforced row alone is a signal too: t2's run 19:19:07.787 → 19:19:15.843, row at 19:19:12.000.
    rows.push({ id: "loop-5", timestamp: "2026-09-25T19:19:12.000Z", type: "sub_agent_tool_loop_enforced", sessionId: `sub:${SESSION}:image_creator:1790363947782`, data: { action: "refuse" } });
    expect(leverColumn(rows, "loop_brake")).toEqual([18_886, 3_843, 0, 0]);
  });

  it("shows headersMs of a stream call timed from the send, and says which clock each row used", () => {
    const rows = editableRows();
    rowAt(rows, "provider_model_call", "2026-09-25T19:17:45.479Z").data["headersMs"] = 180;
    const report = attributeLatency(rows);
    const first = report.turns[0]!.timeline.find((entry) => entry.label === "orchestrator")!;
    expect(first.headersMs).toBe(180);
    expect(first.prefillMs).toBe(3_040);
    // 21 stream calls in the session, one of them now timed from the send.
    expect(report.notes.some((note) => note.startsWith("20 stream call(s) were timed from their response headers"))).toBe(true);
    expect(report.notes.some((note) => note.startsWith("Stream calls carrying headersMs were timed from the send"))).toBe(true);
  });

  it("scales classifier levers by coverage and leaves restructurings alone", () => {
    const half = attributeLatency(fixtureRows(), { coverage: 0.5 }).turns[0]!;
    expect(half.levers.laya_gate_calls).toBe(Math.round(3_777 / 2));
    expect(half.levers.pre_router_dispatch).toBe(Math.round(24_833 / 2));
    expect(half.levers.agent_search_wait).toBe(11_718);
    expect(half.levers.subagent_prewarm).toBe(5_567);
  });

  it("each lever is a function of one turn returning its critical-path milliseconds", () => {
    const [t1] = buildTurnContexts(fixtureRows()).turns;
    const byId = Object.fromEntries(LEVERS.map((lever) => [lever.id, Math.round(leverSavingMs(lever, t1!, DEFAULT_LATENCY_PARAMS))]));
    expect(byId).toEqual({
      laya_gate_calls: 3_777,
      pre_router_dispatch: 24_833,
      plan_round_fold: 0,
      subagent_prewarm: 5_567,
      prefix_cache_kept: 0,
      agent_search_wait: 11_718,
      qa_verdict_candidate: 0,
      vision_structuring: 0,
      loop_brake: 0,
    });
    for (const lever of LEVERS) expect(lever.assumption(DEFAULT_LATENCY_PARAMS).length).toBeGreaterThan(40);
  });
});

describe("what layer 3 takes from these turns", () => {
  it("counts how often each decision point is asked and what its judge costs", () => {
    const report = attributeLatency(fixtureRows());
    expect(report.decisionPoints).toEqual([
      // Judge: 1,973 / 1,819 / 1,179 / 1,187 ms. Nearest-rank p50 of four is the second smallest.
      { point: "source_sensitive", calls: 4, turns: 4, perTurn: 1, p50Ms: 1_187, meanMs: Math.round(6_158 / 4), claimable: 4 },
      // Receptionist: 1,844 / 2,164 / 1,863 ms; turn 2 skipped it (not short and conversational).
      { point: "fast_lane", calls: 3, turns: 3, perTurn: 0.75, p50Ms: 1_863, meanMs: 1_957, claimable: 3 },
    ]);
    expect(report.handoff.frequencyPerTurn).toEqual({ source_sensitive: 1, fast_lane: 0.75 });
  });

  it("does not offer Laya a receptionist call it may not take", () => {
    const rows = editableRows();
    rowAt(rows, "message_received", "2026-09-25T19:17:35.602Z").data = { fastLane: true, length: 42 };
    expect(attributeLatency(rows).decisionPoints.find((point) => point.point === "fast_lane")?.claimable).toBe(2);
  });

  it("hands decisions:bench only the points it has cases for, and names the others beside it", () => {
    const rows = editableRows();
    // A goal-met check inside turn 1's image_creator run, between its two calls: 19:18:19.100 → 19:18:20.000.
    const sub = rowAt(rows, "sub_agent_started", "2026-09-25T19:18:05.545Z").sessionId!;
    rows.push({
      id: "goal-met-1",
      timestamp: "2026-09-25T19:18:20.000Z",
      type: "provider_model_call",
      sessionId: sub,
      data: { callSite: "routing_tier", agentName: "goal_met_oversight", mode: "complete", durationMs: 900, promptTokens: 700, completionTokens: 2, toolCount: 0 },
    });
    const report = attributeLatency(rows);
    expect(report.handoff.frequencyPerTurn).toEqual({ source_sensitive: 1, fast_lane: 0.75, goal_met: 0.25 });
    // A sub-agent's judge is on its run's critical path: claimed like the gate calls.
    expect(report.turns[0]!.levers.laya_gate_calls).toBe(3_777 + 880);
    const markdown = renderLatencyMarkdown(report);
    expect(markdown).toContain("`decisions:bench --frequency source_sensitive=1,fast_lane=0.75`");
    expect(markdown).toContain("points decisions:bench has no cases for yet: goal_met 0.25");
  });

  it("measures the routing round a pre-router would skip, unscaled by coverage", () => {
    // First orchestrator call → dispatch: 24,853 / 9,015 / 11,083 / 17,856 ms.
    const expected = { turns: 4, p50: 11_083, mean: Math.round((24_853 + 9_015 + 11_083 + 17_856) / 4) };
    expect(attributeLatency(fixtureRows()).handoff.preRouterRoundMs).toEqual(expected);
    expect(attributeLatency(fixtureRows(), { coverage: 0.3 }).handoff.preRouterRoundMs).toEqual(expected);
    expect(renderLatencyMarkdown(attributeLatency(fixtureRows()))).toContain("`routing:prerouter --round-ms 11083`");
  });
});

describe("no second is counted twice", () => {
  it("counts the stretch two levers share once in the combined saving and lists the pair", () => {
    const report = attributeLatency(fixtureRows());
    // t1: search_agents' excess lies inside the pre-router's span; the gate calls end before it starts,
    // the cold sub-agent call starts after the dispatch. t4: the plan round lies inside the pre-router's span.
    expect(report.turns.map((turn) => turn.combinedMs)).toEqual([
      3_777 + 24_833 + 5_567,
      1_799 + 8_995,
      3_303 + 11_063,
      3_010 + 17_836 + 3_148,
    ]);
    expect(report.overlaps).toEqual([
      { a: "pre_router_dispatch", b: "plan_round_fold", ms: 5_356, turns: 1 },
      { a: "pre_router_dispatch", b: "agent_search_wait", ms: 11_718, turns: 1 },
    ]);
    expect(report.combined.doubleCountedMs).toBe(5_356 + 11_718);
    expect(report.combined.naiveSumMs - report.combined.combinedMs).toBe(report.combined.doubleCountedMs);
    expect(report.combined.combinedMs).toBe(34_177 + 10_794 + 14_366 + 23_994);
  });

  it("takes the largest weight at each instant, never the sum", () => {
    const claims: LeverClaim[] = [
      { lever: "pre_router_dispatch", startMs: 0, endMs: 10_000, weight: 0.5 },
      { lever: "agent_search_wait", startMs: 4_000, endMs: 14_000, weight: 1 },
    ];
    // 0–4 s at 0.5, 4–14 s at 1: 2 + 10.
    expect(weightedUnionMs(claims)).toBe(12_000);
    // Both claim 4–10 s; adding them would count min(0.5, 1) × 6 s twice.
    expect(weightedOverlapMs([claims[0]!], [claims[1]!])).toBe(3_000);
    expect(weightedUnionMs(claims)).toBe(0.5 * 10_000 + 10_000 - 3_000);
  });

  it("claims nothing after the turn's reply", () => {
    // The reply row moved to 19:17:50.000, while search_agents (19:17:45.482 → 19:18:00.900) still runs.
    const rows = editableRows();
    rowAt(rows, "message_sent", "2026-09-25T19:18:34.049Z").timestamp = "2026-09-25T19:17:50.000Z";
    const t1 = attributeLatency(rows).turns[0]!;
    expect(t1.wallMs).toBe(16_249);
    expect(t1.levers.pre_router_dispatch).toBe(9_365); // 19:17:40.635 → 19:17:50.000
    expect(t1.levers.agent_search_wait).toBe(818); // 19:17:49.182 → 19:17:50.000
    expect(t1.levers.subagent_prewarm).toBe(0); // the cold call starts at 19:18:06.790
    expect(t1.combinedMs).toBe(3_777 + 9_365);
  });

  it("never combines to more than the levers' sum or less than the largest lever, at any coverage", () => {
    for (const coverage of [0, 0.25, 0.5, 0.9, 1]) {
      const report = attributeLatency(fixtureRows(), { coverage });
      for (const turn of report.turns) {
        const values = Object.values(turn.levers);
        // Each figure is rounded to the millisecond on its own: allow that much slack per lever.
        expect(turn.combinedMs).toBeLessThanOrEqual(values.reduce((a, b) => a + b, 0) + values.length);
        expect(turn.combinedMs).toBeGreaterThanOrEqual(Math.max(...values) - 1);
        expect(turn.combinedMs).toBeLessThanOrEqual(turn.wallMs);
      }
    }
  });
});

describe("the report never carries the user's words", () => {
  /** Strings the attribution may print: names of agents, tools and call sites, and enum values. */
  const IDENTIFIER_KEYS = new Set(["callSite", "agentName", "mode", "finishReason", "tool", "phase", "outcome", "outcomeStatus", "qaStatus", "criteriaStatus", "artifactProbeStatus", "escalateReason"]);

  function canaryRows(): AuditRow[] {
    const canaries = new Map<string, string>();
    const canary = (value: string): string => {
      if (!canaries.has(value)) canaries.set(value, `CANARY${canaries.size}X${"x".repeat(Math.max(0, value.length - 8))}`);
      return canaries.get(value)!;
    };
    const walk = (value: unknown, key: string | null): unknown => {
      if (typeof value === "string") return key !== null && IDENTIFIER_KEYS.has(key) ? value : canary(value);
      if (Array.isArray(value)) return value.map((item) => walk(item, null));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
      return value;
    };
    return editableRows().map((row) => {
      const out: Record<string, unknown> = { ...row, data: walk(row.data, null) };
      for (const extra of Object.keys(row)) {
        if (!["id", "timestamp", "type", "sessionId", "data"].includes(extra)) out[extra] = walk((row as unknown as Record<string, unknown>)[extra], null);
      }
      return out as unknown as AuditRow;
    });
  }

  it("prints no string from a row except identifiers, in the JSON or the Markdown", () => {
    const rows = canaryRows();
    const report = attributeLatency(rows);
    const markdown = renderLatencyMarkdown(report, { files: [{ path: "audit.jsonl", rows: rows.length, malformedLines: 0 }], duplicates: 0 });
    expect(JSON.stringify(report)).not.toMatch(/CANARY/);
    expect(markdown).not.toMatch(/CANARY/);
    // The canaries changed no figure: the same rows were read the same way.
    const plain = attributeLatency(fixtureRows());
    expect(report.turns.map((turn) => turn.levers)).toEqual(plain.turns.map((turn) => turn.levers));
    expect(report.turns.map((turn) => turn.messageChars)).toEqual([63, 96, 8, 40]);
  });
});

describe("the Markdown report", () => {
  it("states the data scope before any figure, thin data first of all", () => {
    const markdown = renderLatencyMarkdown(attributeLatency(fixtureRows()));
    const scopeAt = markdown.indexOf("## Data scope");
    const figuresAt = markdown.indexOf("## Where the time goes");
    expect(scopeAt).toBeGreaterThan(-1);
    expect(scopeAt).toBeLessThan(figuresAt);
    const scope = markdown.slice(scopeAt, figuresAt);
    expect(scope).toContain("THIN DATA — 4 turn(s), 1 session(s)");
    expect(scope).toContain("Topics: **unknown**, languages: **unknown**");
    expect(scope).toContain("2026-09-25T19:17:33.751Z → 2026-09-25T20:03:43.899Z");
    expect(markdown).toContain("| **combined, each second once** |");
    expect(markdown).toContain("- pre_router_dispatch × agent_search_wait: 11.7 s in 1 turn(s)");
  });

  it("drops the thin-data banner once enough turns are in", () => {
    const markdown = renderLatencyMarkdown(attributeLatency(fixtureRows(), { thinDataTurns: 4 }));
    expect(markdown).not.toContain("THIN DATA");
  });
});

describe("latency:report arguments", () => {
  const root = resolve("/repo-root");

  it("takes several audit logs, relative to the repo root, and the lever parameters", () => {
    const args = parseLatencyReportArgs(["--audit", "a.jsonl", "--audit", resolve("/elsewhere/b.jsonl"), "--coverage", "0.5", "--laya-ms", "25", "--json"], root);
    expect(args.audits).toEqual([resolve(root, "a.jsonl"), resolve("/elsewhere/b.jsonl")]);
    expect(args.params).toEqual({ coverage: 0.5, layaMs: 25 });
    expect(args.json).toBe(true);
    expect(isAbsolute(args.out)).toBe(true);
  });

  it("defaults to the repo's live audit log and the live-check folder", () => {
    const args = parseLatencyReportArgs([], root);
    expect(args.audits).toEqual([join(root, ".starlingai", "audit.jsonl")]);
    expect(args.out).toBe(join(root, ".starlingai", "live-check", "latency-report"));
    expect(args.json).toBe(false);
  });

  it("refuses what it does not understand", () => {
    expect(() => parseLatencyReportArgs(["--coverage", "1.5"], root)).toThrow(/--coverage/);
    expect(() => parseLatencyReportArgs(["--laya-ms", "-1"], root)).toThrow(/--laya-ms/);
    expect(() => parseLatencyReportArgs(["--audit"], root)).toThrow(/--audit needs a path/);
    expect(() => parseLatencyReportArgs(["--audti", "x"], root)).toThrow(/unknown argument/);
  });
});
