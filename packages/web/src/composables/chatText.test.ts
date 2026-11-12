import { describe, expect, it } from "vitest";
import { chatText } from "./chatText";

describe("chatText", () => {
  it("has both wordings for every label, and they differ where the languages do", () => {
    const sample: Record<string, unknown[]> = {
      enlarge: ["fox.png"], firstCharacters: [500], messagePlaceholder: ["StarlingAI", true],
      launcherTitle: ["StarlingAI"], restartConfirmMessage: [3], resetConfirmMessage: [4],
      showOlder: [5], hideOlder: [5],
    };
    for (const [key, label] of Object.entries(chatText)) {
      const args = sample[key] ?? [];
      const en = (label as (...a: unknown[]) => string)("en", ...args);
      const de = (label as (...a: unknown[]) => string)("de", ...args);
      expect(en.trim(), key).not.toBe("");
      expect(de.trim(), key).not.toBe("");
      // The words both languages share.
      if (!["details", "tabLive"].includes(key)) expect(de, key).not.toBe(en);
    }
  });

  it("names the count the way each language does", () => {
    expect(chatText.restartConfirmMessage("en", 1)).toContain("the 1 message after it");
    expect(chatText.restartConfirmMessage("en", 3)).toContain("the 3 messages after it");
    expect(chatText.restartConfirmMessage("de", 1)).toContain("die 1 Nachricht danach");
    expect(chatText.restartConfirmMessage("de", 3)).toContain("die 3 Nachrichten danach");
  });

  it("mentions commands in the placeholder only where there are commands", () => {
    expect(chatText.messagePlaceholder("en", "StarlingAI", true)).toContain("/ for commands");
    expect(chatText.messagePlaceholder("en", "StarlingAI", false)).not.toContain("/");
    expect(chatText.messagePlaceholder("de", "StarlingAI", true)).toContain("/ für Befehle");
  });
});
