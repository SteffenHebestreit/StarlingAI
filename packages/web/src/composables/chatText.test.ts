import { describe, expect, it } from "vitest";
import { chatText } from "./chatText";
import { turnText } from "./turnText";

describe("chatText", () => {
  it("has both wordings for every label, and they differ where the languages do", () => {
    const sample: Record<string, unknown[]> = {
      enlarge: ["fox.png"], firstCharacters: [500], messagePlaceholder: ["StarlingAI", true],
      launcherTitle: ["StarlingAI"], restartConfirmMessage: [3], resetConfirmMessage: [4],
      showOlder: [5], hideOlder: [5], autoIn: ["0:42"],
    };
    for (const [key, label] of Object.entries(chatText)) {
      const args = sample[key] ?? [];
      const en = (label as (...a: unknown[]) => string)("en", ...args);
      const de = (label as (...a: unknown[]) => string)("de", ...args);
      expect(en.trim(), key).not.toBe("");
      expect(de.trim(), key).not.toBe("");
      // The words both languages share.
      if (!["details", "tabLive", "jobs"].includes(key)) expect(de, key).not.toBe(en);
    }
  });

  it("names the count the way each language does", () => {
    expect(chatText.restartConfirmMessage("en", 1)).toContain("the 1 message after it");
    expect(chatText.restartConfirmMessage("en", 3)).toContain("the 3 messages after it");
    expect(chatText.restartConfirmMessage("de", 1)).toContain("die 1 Nachricht danach");
    expect(chatText.restartConfirmMessage("de", 3)).toContain("die 3 Nachrichten danach");
  });

  it("words a card's countdown like the step row above it", () => {
    for (const lang of ["en", "de"] as const) {
      expect(turnText.waitingForYou(lang, "0:42").toLowerCase()).toContain(chatText.autoIn(lang, "0:42").toLowerCase());
    }
  });

  it("names the card's Configure button in the composer's hint by the label it has", () => {
    for (const lang of ["en", "de"] as const) {
      expect(chatText.cardPlaceholder(lang)).toContain(chatText.configure(lang).replace("…", ""));
    }
  });

  it("mentions commands in the placeholder only where there are commands", () => {
    expect(chatText.messagePlaceholder("en", "StarlingAI", true)).toContain("/ for commands");
    expect(chatText.messagePlaceholder("en", "StarlingAI", false)).not.toContain("/");
    expect(chatText.messagePlaceholder("de", "StarlingAI", true)).toContain("/ für Befehle");
  });
});
