import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE REPLY-LANGUAGE RULE, AND EVERY PLACE THAT HAD ITS OWN COPY.
 *
 * The rule the swarm is meant to follow: definitions are English; what the user reads is in the
 * language they asked for, otherwise the language they wrote in. What the code actually had were
 * four prompt copies that all said "the same language as the user's message" — so "Erkläre mir auf
 * Englisch …" got German — plus hard-coded German defaults, and German word lists that read English
 * as German. These tests pin the one definition and the places that now use it.
 */

const configState = vi.hoisted(() => ({ defaultLanguage: undefined as string | undefined }));

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: vi.fn(() => {
      const base = original.getConfig();
      if (configState.defaultLanguage === undefined) return base;
      return {
        ...base,
        agents: {
          ...base.agents,
          mainAssistant: { ...base.agents.mainAssistant, defaultLanguage: configState.defaultLanguage },
        },
      };
    }),
  };
});

import {
  IN_REPLY_LANGUAGE,
  buildReplyLanguageRule,
  buildTurnReplyLanguageInstruction,
  defaultReplyLanguage,
  detectTurnUserLanguage,
  isFirstUserTurn,
  lastAssistantReplyText,
  localizedFixedText,
} from "../agent/reply-language.js";
import {
  detectTextLanguage,
  languageNameForCode,
  proseForLanguageDetection,
  warmTextLanguageDetector,
} from "../agent/text-language.js";
import { ESCALATE_SENTINEL, buildReceptionistMessages } from "../agent/receptionist.js";
import { formatMainAssistantPersonalityGuidance } from "../personality/service.js";
import { defaultSystemPrompt } from "../agent/session.js";
import { runWithRequestContext } from "../runtime/request-context.js";

beforeAll(async () => {
  await warmTextLanguageDetector();
});

beforeEach(() => {
  configState.defaultLanguage = undefined;
});

describe("the reply-language rule", () => {
  it("puts a requested language first, the message's language second, the conversation's third", () => {
    const rule = buildReplyLanguageRule();
    const order = [
      rule.indexOf("the language the user asked for"),
      rule.indexOf("the language of the user's latest message"),
      rule.indexOf("keep the language the conversation has been using"),
    ];
    for (const position of order) expect(position).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("names the default language only for a message with no language of its own", () => {
    // Named where it cannot apply, the default pulled English questions into German (2026-10-07).
    expect(buildReplyLanguageRule()).not.toContain("German");
    expect(buildTurnReplyLanguageInstruction("ok", "German")).toContain("(German if there is none)");
    expect(buildTurnReplyLanguageInstruction("How should I store the batteries of my power tools over the winter?", "German"))
      .not.toContain("German");
    const german = buildTurnReplyLanguageInstruction("Wie lagere ich die Akkus meiner Elektrowerkzeuge im Winter am besten?", "German");
    expect(german).not.toContain("if there is none)");
    // The precedence stays whole either way.
    expect(german).toContain("the language the user asked for");
    expect(german).toContain("keep the language the conversation has been using");
  });

  it("treats a standing instruction and the durable facts as a request", () => {
    const rule = buildReplyLanguageRule();
    expect(rule).toContain("standing instruction earlier in the conversation");
    expect(rule).toContain("durable facts");
  });

  it("scopes a language named for a deliverable to that deliverable", () => {
    expect(buildReplyLanguageRule()).toContain("applies to that deliverable");
  });

  it("names the message's language on a conversation's first turn only", () => {
    // Unnamed, an English first question still came back German 5 times in 12; named, never. Later
    // turns name none: a standing request written earlier lost to a named language (2026-10-07).
    const english = "How should I store the batteries of my power tools over the winter?";
    const first = buildTurnReplyLanguageInstruction(english, "German", { firstTurn: true });
    expect(first).toContain("otherwise in English, the language of that message");
    // Requests still win: one in the message, or one stored among the durable facts.
    expect(first).toContain("the language the user asked for, if they asked for one — in that message or in the durable facts");
    const later = buildTurnReplyLanguageInstruction(english, "German", { firstTurn: false });
    expect(later).not.toContain("otherwise in English");
    expect(later).toContain("as a standing instruction earlier");
    // A message with no language of its own names no language, only the default.
    const bare = buildTurnReplyLanguageInstruction("ok", "German", { firstTurn: true });
    expect(bare).not.toContain("otherwise in English");
    expect(bare).toContain("(German if there is none)");
  });

  it("knows a first turn by the history holding no earlier user message", () => {
    expect(isFirstUserTurn([])).toBe(true);
    expect(isFirstUserTurn([{ role: "system" }, { role: "user" }])).toBe(true);
    expect(isFirstUserTurn([{ role: "user" }, { role: "assistant" }, { role: "user" }])).toBe(false);
  });

  it("uses the configured default language", () => {
    configState.defaultLanguage = "French";
    expect(defaultReplyLanguage()).toBe("French");
    expect(buildTurnReplyLanguageInstruction("hi")).toContain("(French if there is none)");
  });

  it("defaults to German when nothing is configured", () => {
    expect(defaultReplyLanguage()).toBe("German");
  });

  it("the short form for single-purpose prompts names the requested language first", () => {
    expect(IN_REPLY_LANGUAGE.indexOf("the language the user asked for"))
      .toBeLessThan(IN_REPLY_LANGUAGE.indexOf("the language of their latest message"));
  });
});

describe("every copy in the orchestrator's system prompt agrees", () => {
  it("the base prompt carries the rule, and no German-by-default line", () => {
    const prompt = defaultSystemPrompt();
    expect(prompt).toContain("Reply language: answer in the language the user asked for");
    expect(prompt).not.toMatch(/reply in German\./);
    expect(prompt).not.toContain("Mirror the user's language in every reply");
  });

  it("the personality block carries no second, contradicting language rule", () => {
    const guidance = formatMainAssistantPersonalityGuidance();
    expect(guidance).not.toContain("default to German");
    expect(guidance).not.toContain("same language as the user's latest message");
  });
});

describe("receptionist language line", () => {
  it("answers a bare greeting in the conversation's language when there is one", () => {
    const content = String(buildReceptionistMessages("hi", { conversationLanguage: "English", defaultLanguage: "German" })[0]!.content);
    expect(content).toContain("Reply in ENGLISH");
    expect(content).toContain("the language this conversation has been using");
    expect(content).not.toContain("Reply in GERMAN");
  });

  it("falls back to the configured default, not a hard-coded German", () => {
    const content = String(buildReceptionistMessages("👍", { defaultLanguage: "French" })[0]!.content);
    expect(content).toContain("Reply in FRENCH");
    expect(content).toContain("French is this assistant's default language");
  });

  it("keeps the measured-best line for a message that carries a language", () => {
    // Counter-intuitive and deliberate (see receptionist.ts): on the routing model this line gets a
    // requested language either honoured or ESCALATED to the full assistant; every "if the user asks
    // for a language" variant answered in the wrong language 3-5x more often. Pinned so it is not
    // "fixed" back into one of them.
    const content = String(buildReceptionistMessages("Sag bitte hallo auf Englisch zu meinem Kollegen")[0]!.content);
    expect(content).toContain("ALWAYS reply in the SAME language as the user's message (German → German, English → English). Never switch the language.");
    expect(content).toContain(ESCALATE_SENTINEL);
  });
});

describe("text-language — a statistical detector, not a word list", () => {
  it("names the language of ordinary prose", () => {
    expect(detectTextLanguage("Das ist die Zusammenfassung der Recherche zu den Serverkosten.")?.name).toBe("German");
    expect(detectTextLanguage("Here is the summary of the research on server costs.")?.name).toBe("English");
    expect(detectTextLanguage("Voici le résumé de la recherche sur les coûts des serveurs.")?.name).toBe("French");
  });

  it("does not read English 'was' / 'die' as German (the old word list did)", () => {
    expect(detectTextLanguage("It was fine, the die was cast and the result was good.")?.code).toBe("en");
  });

  it("returns null rather than guess on too little text", () => {
    expect(detectTextLanguage("ok")).toBeNull();
    expect(detectTextLanguage("hi")).toBeNull();
    expect(detectTextLanguage("")).toBeNull();
    expect(detectTextLanguage(undefined)).toBeNull();
  });

  it("ignores code, links and markup, which carry n-grams of their own", () => {
    // A bare URL scores as confident Portuguese when it is left in.
    expect(detectTextLanguage("https://example.com/foo/bar-baz")).toBeNull();
    const prose = proseForLanguageDetection("Siehe `npm run build` und https://example.com/docs sowie ```js\nconst x = 1;\n``` hier.");
    expect(prose).not.toContain("example.com");
    expect(prose).not.toContain("const x");
    expect(prose).not.toContain("npm run build");
  });

  it("names codes in English", () => {
    expect(languageNameForCode("de")).toBe("German");
    expect(languageNameForCode("pl")).toBe("Polish");
  });
});

describe("the person's language for fixed text", () => {
  const history = [
    { role: "user", content: "Wie spät ist es in Tokio?" },
    { role: "assistant", content: null },
    { role: "tool", content: "{\"time\":\"09:00\"}" },
    { role: "assistant", content: "In Tokio ist es gerade neun Uhr morgens." },
  ];

  it("reads the previous reply, skipping tool-call turns with no prose", () => {
    expect(lastAssistantReplyText(history)).toBe("In Tokio ist es gerade neun Uhr morgens.");
    expect(lastAssistantReplyText([])).toBeUndefined();
  });

  it("uses the message, and the previous reply only when the message has no language of its own", () => {
    expect(detectTurnUserLanguage("What time is it in Osaka right now?", history)).toBe("English");
    expect(detectTurnUserLanguage("ok", history)).toBe("German");
    expect(detectTurnUserLanguage("ok", [])).toBeUndefined();
  });

  it("picks the German or the English form by the turn's language, the default when unknown", () => {
    const forms = { de: "Fortschritts-Check", en: "Progress check" };
    expect(runWithRequestContext({ userMessageLanguage: "German" }, () => localizedFixedText(forms))).toBe("Fortschritts-Check");
    expect(runWithRequestContext({ userMessageLanguage: "English" }, () => localizedFixedText(forms))).toBe("Progress check");
    // A third language gets English: these lines have no other forms.
    expect(runWithRequestContext({ userMessageLanguage: "French" }, () => localizedFixedText(forms))).toBe("Progress check");
    // Unknown: the configured default.
    expect(localizedFixedText(forms)).toBe("Fortschritts-Check");
    configState.defaultLanguage = "English";
    expect(localizedFixedText(forms)).toBe("Progress check");
  });
});
