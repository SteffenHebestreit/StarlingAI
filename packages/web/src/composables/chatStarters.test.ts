import { describe, expect, it } from "vitest";
import { chatStarters, startersVisible, type StarterConditions } from "./chatStarters";

describe("the starters of an empty chat", () => {
  it("speak the browser's language, English where there is no German", () => {
    for (const language of ["de", "de-DE", "de-AT", "de_CH"]) {
      expect(chatStarters(language).lead, language).toBe("Womit soll ich anfangen?");
    }
    for (const language of ["en-US", "fr-FR", "pl", "", null, undefined]) {
      expect(chatStarters(language).lead, String(language)).toBe("What shall I start with?");
    }
  });

  it("leave every prompt open for the user to finish, in both languages alike", () => {
    const german = chatStarters("de").items;
    const english = chatStarters("en").items;
    expect(german.length).toBe(english.length);
    for (const { label, prompt } of [...german, ...english]) {
      expect(prompt.endsWith(" "), label).toBe(true);
    }
    expect(new Set(german.map((item) => item.label)).size).toBe(german.length);
    expect(new Set(english.map((item) => item.label)).size).toBe(english.length);
  });
});

describe("when the starters show", () => {
  const empty: StarterConditions = {
    connected: true,
    transcriptLoading: false,
    turnRunning: false,
    questionOpen: false,
    messageCount: 0,
    composerOpen: false,
    composerHasContent: false,
  };

  it("on an empty chat", () => {
    expect(startersVisible(empty)).toBe(true);
  });

  it.each<[string, Partial<StarterConditions>]>([
    ["before the connection stands: the session's messages have not been asked for yet", { connected: false }],
    ["while a session's messages load: they would flash on a chat that has a history", { transcriptLoading: true }],
    ["while a turn runs", { turnRunning: true }],
    ["while a question waits for its answer", { questionOpen: true }],
    ["once there is a message", { messageCount: 1 }],
    ["while the input is up: on a phone it would cover them", { composerOpen: true }],
    ["while something waits in the input: a click would replace it", { composerHasContent: true }],
  ])("not %s", (_case, change) => {
    expect(startersVisible({ ...empty, ...change })).toBe(false);
  });
});
