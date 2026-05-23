import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Time-series telemetry → QuestDB.
 *
 * Covers (1) the line-protocol emission shape from audit events — integer
 * token/duration fields and a always-decimal cost_usd so QuestDB never flips
 * the column type — and (2) the QuestDB-backed durable cost summary parsing.
 */

const questWriteMock = vi.fn(async (_line: string | string[]) => {});
let questAvailable = true;
let questQueryImpl: (sql: string) => Promise<Record<string, unknown>[]> = async () => [];

vi.mock("../db/questdb.js", () => ({
  isQuestDbAvailable: () => questAvailable,
  questWrite: (line: string | string[]) => questWriteMock(line),
  questQuery: (sql: string) => questQueryImpl(sql),
  escapeLineTag: (s: string) => s.replace(/[ ,=]/g, "_"),
}));

function writeConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "starlingai-telemetry-"));
  writeFileSync(
    join(dir, "starlingai.json"),
    JSON.stringify({ cost: { enabled: true, currency: "USD" } }),
    "utf8",
  );
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  process.env["SAI_AUDIT_LOG"] = join(dir, "audit.jsonl");
  process.env["QUESTDB_URL"] = "http://questdb:9000";
  return dir;
}

describe("time-series telemetry", () => {
  let dir: string;

  beforeEach(() => {
    dir = writeConfig();
    questWriteMock.mockClear();
    questAvailable = true;
    questQueryImpl = async () => [];
    vi.resetModules();
  });

  afterEach(async () => {
    const telemetry = await import("../observability/telemetry.js");
    telemetry.stopTimeseriesTelemetry();
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_AUDIT_LOG"];
    delete process.env["QUESTDB_URL"];
    rmSync(dir, { recursive: true, force: true });
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("emits llm_usage + sub_agent_run lines from a sub_agent_completed event", async () => {
    const telemetry = await import("../observability/telemetry.js");
    const { logAudit } = await import("../audit/logger.js");
    telemetry.startTimeseriesTelemetry();

    logAudit(
      "sub_agent_completed",
      {
        agentName: "researcher",
        model: "claude-sonnet-4",
        iterations: 3,
        durationMs: 1500,
        usage: { promptTokens: 1000, completionTokens: 2000, totalTokens: 3000 },
      },
      { sessionId: "sess-1" },
    );

    const lines = questWriteMock.mock.calls.map((c) => String(c[0]));
    const usageLine = lines.find((l) => l.startsWith("llm_usage,"));
    const runLine = lines.find((l) => l.startsWith("sub_agent_run,"));

    expect(usageLine).toBeDefined();
    expect(runLine).toBeDefined();

    // Tags
    expect(usageLine).toContain("model=claude-sonnet-4");
    expect(usageLine).toContain("agent=researcher");
    expect(usageLine).toContain("session=sess-1");
    // Integer token fields carry the `i` suffix
    expect(usageLine).toContain("total_tokens=3000i");
    expect(usageLine).toContain("prompt_tokens=1000i");
    // cost_usd is always a decimal (0.033 here) so the column stays DOUBLE
    expect(usageLine).toMatch(/cost_usd=\d+\.\d+/);

    expect(runLine).toContain("duration_ms=1500i");
    expect(runLine).toContain("iterations=3i");
  });

  it("forces an exact-zero cost to a decimal so the column never becomes LONG", async () => {
    const telemetry = await import("../observability/telemetry.js");
    const { logAudit } = await import("../audit/logger.js");
    telemetry.startTimeseriesTelemetry();

    // Unknown model → no rate-card match → cost 0; must still serialize as 0.0
    logAudit(
      "turn_performance",
      { model: "local/unpriced", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } },
      { sessionId: "sess-2" },
    );

    const usageLine = questWriteMock.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.startsWith("llm_usage,"));
    expect(usageLine).toContain("agent=orchestrator");
    expect(usageLine).toContain("cost_usd=0.0");
  });

  it("emits tool_latency and skips cached tool calls", async () => {
    const telemetry = await import("../observability/telemetry.js");
    const { logAudit } = await import("../audit/logger.js");
    telemetry.startTimeseriesTelemetry();

    logAudit("tool_call_completed", { tool: "web_search", success: true, durationMs: 220, outputChars: 4096 }, { sessionId: "s" });
    logAudit("tool_call_completed", { tool: "web_search", success: true, durationMs: 0, outputChars: 10, cachedResult: true }, { sessionId: "s" });

    const toolLines = questWriteMock.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("tool_latency,"));
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0]).toContain("tool=web_search");
    expect(toolLines[0]).toContain("ok=true");
    expect(toolLines[0]).toContain("duration_ms=220i");
  });

  it("assembles a CostSummary from the QuestDB llm_usage series", async () => {
    questQueryImpl = async (sql: string) => {
      if (sql.includes("SAMPLE BY")) {
        return [{ timestamp: "2026-05-20T00:00:00.000000Z", p: 1000, c: 2000, t: 3000, cost: 0.033, n: 1 }];
      }
      if (/GROUP BY agent/.test(sql)) {
        return [{ agent: "researcher", p: 1000, c: 2000, t: 3000, cost: 0.033, n: 1, last: "2026-05-20T01:00:00.000000Z" }];
      }
      if (/GROUP BY model/.test(sql)) {
        return [{ model: "claude-sonnet-4", p: 1000, c: 2000, t: 3000, cost: 0.033, n: 1, last: "2026-05-20T01:00:00.000000Z" }];
      }
      if (/GROUP BY session/.test(sql)) {
        return [{ session: "sess-1", p: 1000, c: 2000, t: 3000, cost: 0.033, n: 1, last: "2026-05-20T01:00:00.000000Z" }];
      }
      return [];
    };

    const telemetry = await import("../observability/telemetry.js");
    const summary = await telemetry.getCostSummaryFromTimeseries(30);

    expect(summary).not.toBeNull();
    expect(summary!.rangeDays).toBe(30);
    expect(summary!.currency).toBe("USD");
    expect(summary!.totalTokens).toBe(3000);
    expect(summary!.totalCost).toBe(0.03); // round2(0.033)
    expect(summary!.byDay[0]!.day).toBe("2026-05-20");
    expect(summary!.byAgent[0]!.source).toBe("researcher");
    expect(summary!.byModel[0]!.source).toBe("claude-sonnet-4");
    expect(summary!.bySession[0]!.source).toBe("sess-1");
  });

  it("returns null (→ in-memory fallback) when the series is empty", async () => {
    questQueryImpl = async () => [];
    const telemetry = await import("../observability/telemetry.js");
    expect(await telemetry.getCostSummaryFromTimeseries(30)).toBeNull();
  });

  it("returns null when QuestDB is unavailable", async () => {
    questAvailable = false;
    const telemetry = await import("../observability/telemetry.js");
    expect(await telemetry.getCostSummaryFromTimeseries(30)).toBeNull();
  });
});
