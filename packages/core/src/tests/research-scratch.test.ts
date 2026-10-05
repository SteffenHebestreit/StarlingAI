import { afterEach, describe, expect, it, vi } from "vitest";
import { getTool, type ToolContext, type ToolHandler } from "../tools/registry.js";
import "../tools/research-scratch.js"; // registers research_note* tools

const t = (name: string): ToolHandler => {
  const h = getTool(name);
  if (!h) throw new Error(`tool ${name} not registered`);
  return h;
};
// Unique session per test so the in-memory (QuestDB-fallback) notes don't mix.
const ctxFor = (id: string) => ({ sessionId: `rs-${id}-${Date.now()}` } as unknown as ToolContext);

describe("research-scratch tools (in-memory fallback)", () => {
  it("research_note requires content", async () => {
    const r = await t("research_note").execute({ topic: "x", content: "" }, ctxFor("v"));
    expect(r.success).toBe(false);
  });

  it("write → read groups by topic and renders importance/source", async () => {
    const ctx = ctxFor("read");
    await t("research_note").execute({ topic: "findings", content: "alpha fact", importance: "high", source: "https://ex.com/a" }, ctx);
    await t("research_note").execute({ topic: "findings", content: "beta fact", importance: "low" }, ctx);
    await t("research_note").execute({ topic: "sources", content: "gamma" }, ctx);

    const read = await t("research_notes_read").execute({}, ctx);
    expect(read.success).toBe(true);
    expect(read.output).toContain("Research Notes (3 total)");
    expect(read.output).toContain("### findings");
    expect(read.output).toContain("### sources");
    expect(read.output).toContain("alpha fact ⭐");
    expect(read.output).toContain("*Source: https://ex.com/a*");
    expect(read.output).toContain("beta fact (low)");
  });

  it("read can filter by topic and by minimum importance", async () => {
    const ctx = ctxFor("filter");
    await t("research_note").execute({ topic: "a", content: "high one", importance: "high" }, ctx);
    await t("research_note").execute({ topic: "a", content: "low one", importance: "low" }, ctx);
    await t("research_note").execute({ topic: "b", content: "other" }, ctx);

    const byTopic = await t("research_notes_read").execute({ topic: "a" }, ctx);
    expect(byTopic.output).toContain("high one");
    expect(byTopic.output).not.toContain("other");

    const byImportance = await t("research_notes_read").execute({ importance: "high" }, ctx);
    expect(byImportance.output).toContain("high one");
    expect(byImportance.output).not.toContain("low one");
  });

  it("summary counts, and clear empties the scratchpad", async () => {
    const ctx = ctxFor("clear");
    await t("research_note").execute({ topic: "t", content: "n1" }, ctx);
    await t("research_note").execute({ topic: "t", content: "n2" }, ctx);

    const summary = await t("research_notes_summary").execute({}, ctx);
    expect(summary.success).toBe(true);
    expect(summary.output).toMatch(/note\(s\)/);

    const cleared = await t("research_notes_clear").execute({}, ctx);
    expect(cleared.success).toBe(true);

    const afterRead = await t("research_notes_read").execute({}, ctx);
    expect(afterRead.output).toContain("No research notes found");
    const afterSummary = await t("research_notes_summary").execute({}, ctx);
    expect(afterSummary.output).toContain("No research notes yet");
  });
});

/**
 * The scratchpad is a hand-off between agents of ONE turn: the researcher writes, the writer reads.
 * Each case below is a way that hand-off answered "No research notes" while notes existed.
 */
describe("research-scratch hand-off", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env["QUESTDB_URL"];
  });

  it("a note the researcher sub-agent wrote is read by the writer sub-agent of the same turn", async () => {
    const root = `rs-root-${Date.now()}`;
    const researcher = { sessionId: `sub:${root}:researcher:1700000000001` } as unknown as ToolContext;
    const writer = { sessionId: `sub:${root}:content_writer:1700000000002` } as unknown as ToolContext;
    await t("research_note").execute({ topic: "findings", content: "the market grew 12% in 2025" }, researcher);

    const read = await t("research_notes_read").execute({}, writer);
    expect(read.output).toContain("the market grew 12% in 2025");
    expect(read.output).toContain("Searched: ephemeral store (1).");
  });

  it("filters by a topic written with spaces, as it was stored", async () => {
    const ctx = ctxFor("topic-space");
    await t("research_note").execute({ topic: "key findings", content: "spaced topic note" }, ctx);
    const read = await t("research_notes_read").execute({ topic: "key findings" }, ctx);
    expect(read.output).toContain("spaced topic note");
  });

  it("applies the importance filter before the limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ctx = ctxFor("importance-limit");
    const t0 = Date.parse("2026-10-05T10:00:00.000Z");
    vi.setSystemTime(t0);
    await t("research_note").execute({ topic: "x", content: "the one high note", importance: "high" }, ctx);
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(t0 + i * 1000);
      await t("research_note").execute({ topic: "x", content: `low note ${i}`, importance: "low" }, ctx);
    }
    const read = await t("research_notes_read").execute({ importance: "high", limit: 1 }, ctx);
    expect(read.output).toContain("the one high note");
  });

  it("merges QuestDB and the ephemeral store, and names both", async () => {
    const ctx = ctxFor("merge");
    await t("research_note").execute({ topic: "findings", content: "ephemeral note" }, ctx);   // no QuestDB yet
    process.env["QUESTDB_URL"] = "http://questdb.test";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      columns: [{ name: "topic" }, { name: "content" }, { name: "source" }, { name: "importance" }, { name: "ts" }],
      dataset: [["findings", "questdb note", "", "medium", "2026-10-05T09:00:00.000000Z"]],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const read = await t("research_notes_read").execute({}, ctx);
    expect(read.output).toContain("questdb note");
    expect(read.output).toContain("ephemeral note");
    expect(read.output).toContain("Searched: QuestDB (1), ephemeral store (1).");
    const sql = new URL(String((fetchMock.mock.calls[0] as unknown[])[0])).searchParams.get("query") ?? "";
    expect(sql).toContain(`session = '${ctx.sessionId}'`);
  });

  it("fails instead of answering 'no notes' when a store could not be read", async () => {
    const ctx = ctxFor("quest-down");
    process.env["QUESTDB_URL"] = "http://questdb.test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const read = await t("research_notes_read").execute({}, ctx);
    expect(read.success).toBe(false);
    expect(read.error).toMatch(/QuestDB FAILED .*503.* — notes stored there are missing from this answer.*not evidence that none were saved/);
  });
});

/**
 * Keyed by the chat's root session, the scratchpad is shared by every agent of every turn of a chat.
 * A clear by one parallel slice wiped its sibling's notes, and reads ranked turn 1's notes first.
 */
describe("research-scratch across agents and turns", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env["QUESTDB_URL"];
  });

  it("clears only the caller's own notes unless asked for all agents", async () => {
    const root = `rs-clear-${Date.now()}`;
    const sliceA = { sessionId: `sub:${root}:researcher:1700000000001` } as unknown as ToolContext;
    const sliceB = { sessionId: `sub:${root}:researcher:1700000000002` } as unknown as ToolContext;
    const writer = { sessionId: `sub:${root}:content_writer:1700000000003` } as unknown as ToolContext;
    await t("research_note").execute({ topic: "findings", content: "slice A finding" }, sliceA);
    await t("research_note").execute({ topic: "findings", content: "slice B finding" }, sliceB);

    const own = await t("research_notes_clear").execute({}, sliceA);
    expect(own.output).toContain("Cleared 1 note(s) from the ephemeral store. Kept 1 note(s) other agents saved — pass all_agents: true");
    const afterOwn = await t("research_notes_read").execute({}, writer);
    expect(afterOwn.output).toContain("slice B finding");
    expect(afterOwn.output).not.toContain("slice A finding");

    const all = await t("research_notes_clear").execute({ all_agents: true }, writer);
    expect(all.metadata?.["deleted"]).toBe(1);
    expect((await t("research_notes_read").execute({}, writer)).output).toContain("No research notes found");
  });

  it("reads this turn's notes, says how many earlier ones it left out, and reads all on request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const root = `rs-turns-${Date.now()}`;
    const turnStart = Date.parse("2026-10-05T12:00:00.000Z");
    vi.setSystemTime(turnStart - 3_600_000);
    await t("research_note").execute({ topic: "findings", content: "last turn's finding" }, { sessionId: `sub:${root}:researcher:1` } as unknown as ToolContext);
    vi.setSystemTime(turnStart + 1_000);
    await t("research_note").execute({ topic: "findings", content: "this turn's finding" }, { sessionId: `sub:${root}:researcher:2` } as unknown as ToolContext);

    // A sub-agent knows the turn through the swarm state it inherits.
    const writer = { sessionId: `sub:${root}:content_writer:3`, swarmState: { startedAt: new Date(turnStart).toISOString() } } as unknown as ToolContext;
    const read = await t("research_notes_read").execute({}, writer);
    expect(read.output).toContain("this turn's finding");
    expect(read.output).not.toContain("last turn's finding");
    expect(read.output).toContain("Notes from this turn; 1 note(s) from earlier turns of this chat not shown — pass all_turns: true to include them.");

    const all = await t("research_notes_read").execute({ all_turns: true }, writer);
    expect(all.output).toContain("last turn's finding");
    expect(all.output).toContain("this turn's finding");
  });

  it("keeps the newest notes under a limit and says how many it left out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ctx = ctxFor("newest");
    const t0 = Date.parse("2026-10-05T10:00:00.000Z");
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(t0 + i * 1000);
      await t("research_note").execute({ topic: "x", content: `note ${i}` }, ctx);
    }
    const read = await t("research_notes_read").execute({ limit: 2 }, ctx);
    expect(read.output).not.toContain("note 1");
    expect(read.output.indexOf("note 2")).toBeLessThan(read.output.indexOf("note 3"));
    expect(read.output).toContain("Showing the newest 2 of 3 matching notes");
  });

  it("asks QuestDB newest first and says how many it did not load", async () => {
    const ctx = ctxFor("quest-count");
    process.env["QUESTDB_URL"] = "http://questdb.test";
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const sql = new URL(String(input)).searchParams.get("query") ?? "";
      queries.push(sql);
      const body = sql.includes("count()")
        ? { columns: [{ name: "n" }], dataset: [[750]] }
        : { columns: [{ name: "topic" }, { name: "content" }, { name: "source" }, { name: "importance" }, { name: "ts" }], dataset: [["findings", "newest quest note", "", "medium", "2026-10-05T09:00:00.000000Z"]] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const read = await t("research_notes_read").execute({}, ctx);
    expect(queries.some((sql) => /ORDER BY timestamp DESC LIMIT 500/.test(sql))).toBe(true);
    expect(read.output).toContain("QuestDB holds 750 matching notes; only the newest 1 were read.");
    expect(read.metadata?.["matching"]).toBe(750);
  });
});
