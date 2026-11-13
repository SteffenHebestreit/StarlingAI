import { describe, expect, it } from "vitest";
import { chatText } from "./chatText";
import { turnText } from "./turnText";

describe("chatText", () => {
  it("has both wordings for every label, and they differ where the languages do", () => {
    const sample: Record<string, unknown[]> = {
      enlarge: ["fox.png"], firstCharacters: [500], messagePlaceholder: ["StarlingAI", true],
      launcherTitle: ["StarlingAI"], restartConfirmMessage: [3], resetConfirmMessage: [4],
      showOlder: [5], hideOlder: [5],
      followUp: ["Release watch"], followUpEnded: ["max_runs", 3], autoIn: ["0:42"],
      cannotEditPicture: ["Fast"], fixedSizeOnly: [512], baseSource: ["agent"], tooLargeRendersAt: [1024, 768],
      editsByInstruction: ["Quality"], maskOfYours: ["35%"], sizeAxis: ["width"], sizeTooLargeRenders: [1024, 768],
      engineFixedSize: [512], sizeRule: [16, 256, 2048], widthAndHeightErrors: ["too wide", "too tall"],
      engineDefault: [30], fieldsNeedAttention: [2], mayChange: ["35%"],
      effortName: ["medium"], effortDescription: ["medium"], effortLabel: ["medium"], effortTitle: ["medium"],
      imagesChip: ["ask"], imagesTitle: ["ask"], thinkingChip: [true], thinkingTitle: [true],
      notSent: ["too large"], couldNotStop: ["timeout"], couldNotRestart: ["timeout"], couldNotArchive: ["timeout"],
      fileAttached: ["report.pdf"], uploadingDocuments: [2], analysingImages: [1],
      gatewayNoAnswer: [504], serverSentPage: [404],
      previewFile: ["fox.png"], removeNamed: ["fox.png"], voiceEyebrow: [true], sayWakeWord: ["Luna"],
      listeningFor: ["Luna"], wakePhraseDetected: ["Luna"], wakeRecognitionError: ["network"], transcriptReady: ["de"],
      transcribingFile: ["memo.wav"], audioAddedFrom: ["memo.wav"], wakeTitle: ["recording"],
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

  it("words the composer's chips in every state, in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const efforts = (["low", "medium", "high", "max"] as const).map((tier) => chatText.effortName(lang, tier));
      expect(new Set(efforts).size).toBe(4);
      for (const tier of ["low", "medium", "high", "max"] as const) {
        expect(chatText.effortDescription(lang, tier)).not.toBe("");
        expect(chatText.effortTitle(lang, tier)).toContain(chatText.effortName(lang, tier));
        expect(chatText.effortTitle(lang, tier)).toContain(chatText.effortDescription(lang, tier));
      }
      expect(new Set([undefined, true, false].map((mode) => chatText.thinkingChip(lang, mode))).size).toBe(3);
      expect(new Set([undefined, true, false].map((mode) => chatText.thinkingTitle(lang, mode))).size).toBe(3);
      expect(chatText.imagesChip(lang, "ask")).not.toBe(chatText.imagesChip(lang, "auto"));
      expect(chatText.imagesTitle(lang, "ask")).not.toBe(chatText.imagesTitle(lang, "auto"));
    }
    expect(chatText.imagesChip("de", "ask")).toBe("Bilder: fragen");
    expect(chatText.thinkingChip("de", undefined)).toBe("Denken: auto");
    expect(chatText.thinkingChip("en", false)).toBe("Thinking: off");
  });

  it("words the voice bar and the wake card in every state, in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const states = ["idle", "listening", "recording", "processing", "success", "error"] as const;
      // "idle" and "listening" share the resting title; the other four are their own.
      expect(new Set(states.map((state) => chatText.wakeTitle(lang, state))).size).toBe(5);
      expect(chatText.voiceEyebrow(lang, true)).not.toBe(chatText.voiceEyebrow(lang, false));
      expect(chatText.recordingPauseOrDone(lang)).toContain(chatText.voiceDone(lang));
      expect(chatText.transcriptReady(lang)).not.toContain("(");
      expect(chatText.transcriptReady(lang, "de")).toContain("(de)");
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
      expect(chatText.steerQueuedBehindCard(lang)).toContain(chatText.configure(lang).replace("…", ""));
    }
  });

  it("names the buttons its notes point at by the labels they have", () => {
    for (const lang of ["en", "de"] as const) {
      expect(chatText.steerUndelivered(lang)).toContain(chatText.resend(lang).replace("↻ ", ""));
      expect(chatText.imageAttached(lang)).toContain(chatText.send(lang));
      expect(chatText.fileAttached(lang, "report.pdf")).toContain(chatText.send(lang));
      expect(chatText.fileAttached(lang, "report.pdf")).toContain("report.pdf");
    }
    expect(chatText.uploadingDocuments("en", 1)).toBe("Uploading document…");
    expect(chatText.uploadingDocuments("en", 2)).toBe("Uploading documents…");
    expect(chatText.analysingImages("de", 1)).toBe("Bild wird analysiert…");
    expect(chatText.analysingImages("de", 3)).toBe("Bilder werden analysiert…");
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
