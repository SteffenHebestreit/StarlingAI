import { describe, expect, it } from "vitest";
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
