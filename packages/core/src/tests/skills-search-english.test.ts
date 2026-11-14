import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE SKILL SEARCH ALSO READS THE REQUEST IN ENGLISH (skills/service.ts, agent/routing-english.ts).
 *
 * A skill is written by the model in whatever language its conversation ran in, so the request is
 * scored as written AND in English and each skill keeps the better score: a German request finds
 * a skill written in English, and a request in a skill's own language matches it as before.
 */
const GERMAN = "Erstelle den Wochenbericht aus den Verkaufszahlen";
const ENGLISH = "Build the weekly report from the sales figures";

const english = vi.hoisted(() => ({ renderings: {} as Record<string, string>, asked: [] as Array<{ text: string; budgetMs: number | undefined }> }));
vi.mock("../agent/routing-english.js", () => ({
  routingEnglish: async (text: string, budgetMs?: number) => {
    english.asked.push({ text, budgetMs });
    const rendering = english.renderings[text.trim()];
    return rendering ? { text: rendering, translated: true, outcome: "translated", language: "de" } : { text: text.trim(), translated: false, outcome: "english", language: "en" };
  },
  catalogEnglish: async (text: string) => text,
}));

describe("searching skills in another language than they were written in", () => {
  const dirs: string[] = [];
  afterEach(() => {
    english.renderings = {};
    english.asked = [];
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function library() {
    const ws = mkdtempSync(join(tmpdir(), "starlingai-skills-english-"));
    dirs.push(ws);
    const { writeSkill } = await import("../skills/store.js");
    writeSkill(ws, {
      name: "Weekly Sales Report",
      description: "Build the weekly report from the sales figures and send it to the team.",
      whenToUse: "When the weekly sales report is due.",
      procedure: "1. Load the sales figures.\n2. Build the report.\n3. Send it.",
      tags: ["report", "sales"],
      agents: ["data_analyst"],
      tools: ["read_file"],
      origin: "agent",
    });
    writeSkill(ws, {
      name: "Rechnungen ablegen",
      description: "Eingegangene Rechnungen aus dem Postfach holen und im Ordner Buchhaltung ablegen.",
      whenToUse: "Wenn neue Rechnungen im Postfach liegen.",
      procedure: "1. Postfach nach Rechnungen durchsuchen.\n2. Anhänge speichern.\n3. Im Ordner Buchhaltung ablegen.",
      tags: ["rechnungen", "buchhaltung"],
      agents: ["mail_agent"],
      tools: ["mail_search"],
      origin: "agent",
    });
    return ws;
  }

  it("finds a skill written in English for a German request", async () => {
    const ws = await library();
    const { searchSkills } = await import("../skills/service.js");

    // As written, none of the request's words is in the English skill.
    expect((await searchSkills(ws, GERMAN, { limit: 5 })).map((match) => match.skill.frontmatter.slug)).not.toContain("weekly-sales-report");

    english.renderings = { [GERMAN]: ENGLISH };
    const matches = await searchSkills(ws, GERMAN, { limit: 5 });
    expect(matches[0]?.skill.frontmatter.slug).toBe("weekly-sales-report");
    expect(matches[0]?.matchedTerms.join(" ")).toMatch(/weekly|report|sales/);
  });

  it("still matches a skill written in the request's own language, by the request as written", async () => {
    const ws = await library();
    const { searchSkills } = await import("../skills/service.js");
    const request = "Lege die neuen Rechnungen aus dem Postfach in der Buchhaltung ab";
    const before = await searchSkills(ws, request, { limit: 5 });
    expect(before[0]?.skill.frontmatter.slug).toBe("rechnungen-ablegen");

    // In English the request shares no word with the German skill; its score as written stands.
    english.renderings = { [request]: "File the new invoices from the mailbox in accounting" };
    const after = await searchSkills(ws, request, { limit: 5 });
    expect(after[0]?.skill.frontmatter.slug).toBe("rechnungen-ablegen");
    expect(after[0]?.combinedScore).toBeGreaterThanOrEqual(before[0]!.combinedScore);
  });

  it("waits only briefly for the rendering, and asks for none with no skills to search", async () => {
    const ws = await library();
    const { searchSkills } = await import("../skills/service.js");
    await searchSkills(ws, GERMAN, { limit: 5 });
    expect(english.asked).toEqual([{ text: GERMAN, budgetMs: 1_500 }]);

    const empty = mkdtempSync(join(tmpdir(), "starlingai-skills-english-"));
    dirs.push(empty);
    english.asked = [];
    expect(await searchSkills(empty, GERMAN, { limit: 5 })).toEqual([]);
    expect(english.asked).toEqual([]);
  });
});
