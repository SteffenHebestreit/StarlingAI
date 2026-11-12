import { describe, expect, it } from "vitest";
import { chatText } from "./chatText";
import { turnText } from "./turnText";

describe("chatText", () => {
  it("has both wordings for every label, and they differ where the languages do", () => {
    const sample: Record<string, unknown[]> = {
      enlarge: ["fox.png"], firstCharacters: [500], messagePlaceholder: ["StarlingAI", true],
      launcherTitle: ["StarlingAI"], restartConfirmMessage: [3], resetConfirmMessage: [4],
      showOlder: [5], hideOlder: [5], autoIn: ["0:42"],
      cannotEditPicture: ["Fast"], fixedSizeOnly: [512], baseSource: ["agent"], tooLargeRendersAt: [1024, 768],
      editsByInstruction: ["Quality"], maskOfYours: ["35%"], sizeAxis: ["width"], sizeTooLargeRenders: [1024, 768],
      engineFixedSize: [512], sizeRule: [16, 256, 2048], widthAndHeightErrors: ["too wide", "too tall"],
      engineDefault: [30], fieldsNeedAttention: [2], mayChange: ["35%"],
    };
    for (const [key, label] of Object.entries(chatText)) {
      const args = sample[key] ?? [];
      const en = (label as (...a: unknown[]) => string)("en", ...args);
      const de = (label as (...a: unknown[]) => string)("de", ...args);
      expect(en.trim(), key).not.toBe("");
      expect(de.trim(), key).not.toBe("");
      // The words both languages share.
      if (!["details", "tabLive", "jobs", "engineLegend", "promptLegend", "seedLabel"].includes(key)) expect(de, key).not.toBe(en);
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

  it("words the image form's variable lines in both languages", () => {
    expect(chatText.fieldsNeedAttention("en", 1)).toBe("1 field needs attention");
    expect(chatText.fieldsNeedAttention("en", 3)).toBe("3 fields need attention");
    expect(chatText.fieldsNeedAttention("de", 1)).toBe("1 Feld braucht Aufmerksamkeit");
    expect(chatText.fieldsNeedAttention("de", 3)).toBe("3 Felder brauchen Aufmerksamkeit");
    expect(chatText.maskOfYours("de")).toBe("Deine Maske");
    expect(chatText.maskOfYours("de", "35%")).toContain("35%");
    expect(chatText.sizeAxis("de", "width")).toBe("B");
    // A source this page does not know reads as an earlier picture, in either language.
    for (const lang of ["en", "de"] as const) {
      expect(chatText.baseSource(lang, "something_new")).toBe(chatText.baseSource(lang, "earlier"));
      expect(new Set(["agent", "latest_image", "attachment", "earlier"].map((source) => chatText.baseSource(lang, source))).size).toBe(4);
    }
  });

  it("mentions commands in the placeholder only where there are commands", () => {
    expect(chatText.messagePlaceholder("en", "StarlingAI", true)).toContain("/ for commands");
    expect(chatText.messagePlaceholder("en", "StarlingAI", false)).not.toContain("/");
    expect(chatText.messagePlaceholder("de", "StarlingAI", true)).toContain("/ für Befehle");
  });
});
