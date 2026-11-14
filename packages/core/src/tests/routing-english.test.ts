import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE CATALOGS ARE SEARCHED IN ENGLISH (agent/routing-english.ts).
 *
 * A request in another language is rendered into English by the translation tier before an
 * agent, workflow or tool search runs on it; one in English is searched as written, with no
 * model call. A search never waits on the rendering past its budget, and never fails for it.
 */
const model = vi.hoisted(() => ({
  /** What the translation model answers, per call. */
  answer: (async (_source: string): Promise<string> => "") as (source: string) => Promise<string>,
  calls: [] as Array<{ tier: string; system: string; source: string }>,
  tiers: { translation: false, narration: true },
}));

vi.mock("../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/index.js")>();
  const provider = (tier: string) => ({
    complete: async (messages: Array<{ role: string; content: string }>) => {
      const source = messages.find((message) => message.role === "user")?.content ?? "";
      model.calls.push({ tier, system: messages[0]?.content ?? "", source });
      return { content: await model.answer(source) };
    },
  });
  return {
    ...actual,
    getChatProviderForTier: (tier: string) =>
      (tier === "translation" && model.tiers.translation) || (tier === "narration" && model.tiers.narration) ? provider(tier) : null,
    createChatProvider: () => provider("routing"),
  };
});

const GERMAN = "Wie wird das Wetter heute Nachmittag in Bremen, und brauche ich einen Regenschirm?";
const ENGLISH = "What will the weather be like in Bremen this afternoon, and do I need an umbrella?";

describe("a request in the catalog's language", () => {
  let tempDir = "";
  const useConfig = async (routingEnglish: boolean | undefined) => {
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      workspacePath: tempDir,
      agents: { defaults: { model: { primary: "mock-model" } } },
      ...(routingEnglish === undefined ? {} : { orchestration: { routingEnglish } }),
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../agent/text-language.js")).warmTextLanguageDetector();
    return import("../agent/routing-english.js");
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-routing-english-"));
    model.calls = [];
    model.tiers = { translation: false, narration: true };
    model.answer = async () => ENGLISH;
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("renders a German request into English, once", async () => {
    const { routingEnglish } = await useConfig(true);

    const first = await routingEnglish(GERMAN);
    const again = await routingEnglish(`  ${GERMAN}  `);

    expect(first).toEqual({ text: ENGLISH, translated: true, outcome: "translated", language: "de" });
    expect(again).toEqual(first);
    // One call for both searches, with the request as the user's turn and nothing else of it.
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).toMatchObject({ tier: "narration", source: GERMAN });
    expect(model.calls[0]!.system).toContain("English");
  });

  it("searches an English request as written, and asks no model", async () => {
    const { routingEnglish } = await useConfig(true);

    expect(await routingEnglish(ENGLISH)).toEqual({ text: ENGLISH, translated: false, outcome: "english", language: "en" });
    expect(model.calls).toEqual([]);
  });

  it("does nothing where the deployment has not turned it on", async () => {
    for (const setting of [undefined, false] as const) {
      const { routingEnglish, catalogEnglish } = await useConfig(setting);
      expect(await routingEnglish(GERMAN)).toEqual({ text: GERMAN, translated: false, outcome: "off" });
      expect(await catalogEnglish(GERMAN)).toBe(GERMAN);
    }
    expect(model.calls).toEqual([]);
  });

  it("takes the translation tier before the narration tier, and the routing tier without either", async () => {
    model.tiers = { translation: true, narration: true };
    let english = await useConfig(true);
    await english.routingEnglish(GERMAN);
    expect(model.calls.at(-1)?.tier).toBe("translation");

    model.tiers = { translation: false, narration: false };
    english = await useConfig(true);
    await english.routingEnglish(GERMAN);
    expect(model.calls.at(-1)?.tier).toBe("routing");
  });

  it("searches as written when the model repeats the request", async () => {
    // A text the detector cannot call (a few words) is asked about; for an English one the model
    // says the same words back.
    model.answer = async (source) => `"${source}"`;
    const { routingEnglish } = await useConfig(true);

    const result = await routingEnglish("weather bremen");
    expect(result.translated).toBe(false);
    expect(result.text).toBe("weather bremen");
    expect(["unchanged", "english"]).toContain(result.outcome);
  });

  it("never fails a search: a model error leaves the request as written, and is asked again next time", async () => {
    let fail = true;
    model.answer = async () => { if (fail) throw new Error("model unloaded"); return ENGLISH; };
    const { routingEnglish } = await useConfig(true);

    expect(await routingEnglish(GERMAN)).toEqual({ text: GERMAN, translated: false, outcome: "failed" });
    fail = false;
    expect(await routingEnglish(GERMAN)).toMatchObject({ text: ENGLISH, translated: true });
    expect(model.calls).toHaveLength(2);
  });

  it("does not wait past its budget, and has the rendering for the next search", async () => {
    let release: (value: string) => void = () => undefined;
    model.answer = () => new Promise<string>((resolve) => { release = resolve; });
    const { routingEnglish } = await useConfig(true);

    const startedAt = Date.now();
    const late = await routingEnglish(GERMAN, 40);
    expect(late).toEqual({ text: GERMAN, translated: false, outcome: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    release(ENGLISH);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await routingEnglish(GERMAN, 40)).toMatchObject({ text: ENGLISH, translated: true });
    // The one call that was already under way.
    expect(model.calls).toHaveLength(1);
  });

  it("starts the rendering before anything searches, so the first search finds it done", async () => {
    const { primeRoutingEnglish, routingEnglish } = await useConfig(true);

    primeRoutingEnglish(GERMAN);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(model.calls).toHaveLength(1);
    // No budget at all: only a rendering that is there already can be returned.
    expect(await routingEnglish(GERMAN, 0)).toMatchObject({ text: ENGLISH, translated: true });
    expect(model.calls).toHaveLength(1);
  });

  it("takes only a translation for an answer", async () => {
    const { acceptRendering } = await useConfig(true);

    expect(acceptRendering(GERMAN, `  "${ENGLISH}"  `)).toBe(ENGLISH);
    expect(acceptRendering(GERMAN, "What will the weather\nbe like?")).toBe("What will the weather be like?");
    expect(acceptRendering(GERMAN, "")).toBeNull();
    expect(acceptRendering(GERMAN, "<think>the user asks about weather</think> weather")).toBeNull();
    expect(acceptRendering(GERMAN, "```\nweather\n```")).toBeNull();
    // An answer to the request instead of its translation runs far longer than the request.
    expect(acceptRendering("Wie wird das Wetter?", "The weather in Bremen this afternoon will be partly sunny with a high of 8 degrees and gusty winds from the west, so an umbrella is not needed, but a jacket certainly is.")).toBeNull();
  });

  it("searches as written when the answer is not a translation", async () => {
    model.answer = async () => "<think>translate</think>";
    const { routingEnglish } = await useConfig(true);

    expect(await routingEnglish(GERMAN)).toMatchObject({ text: GERMAN, translated: false, outcome: "unchanged" });
  });

  it("renders a catalog entry written in another language, and leaves an English one as it is", async () => {
    const germanEntry = "Workflow: wochenbericht\nBeschreibung: Erstellt jeden Freitag den Wochenbericht aus den Verkaufszahlen und verschickt ihn an das Team.";
    const englishEntry = "Workflow: weekly_report\nDescription: Builds the weekly report from the sales figures every Friday and sends it to the team.";
    model.answer = async () => englishEntry;
    const { catalogEnglish } = await useConfig(true);

    expect(await catalogEnglish(germanEntry)).toBe(englishEntry);
    expect(await catalogEnglish(germanEntry)).toBe(englishEntry);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.system).toContain("description of a software capability");

    expect(await catalogEnglish(englishEntry)).toBe(englishEntry);
    // A name or a list of identifiers the detector cannot call is left as written.
    expect(await catalogEnglish("fetch_url")).toBe("fetch_url");
    expect(model.calls).toHaveLength(1);
  });
});
