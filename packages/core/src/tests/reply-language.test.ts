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
  messageHasOwnLanguage,
} from "../agent/reply-language.js";
import {
  detectTextLanguage,
  detectUniformTextLanguage,
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

/** What the web chat puts ahead of a picture's typed question: the vision model's analysis. */
const IMAGE_ANALYSIS = "Image analysis (schild.jpg):\n\n## Description\nThe image shows a blue round road sign with a "
  + "white bicycle symbol, mounted on a metal pole next to a street. Below it hangs a smaller white sign with black "
  + "text. Trees and a parked car are in the background.";

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
    const first = buildTurnReplyLanguageInstruction(english, "German", { firstTurn: true, userWords: english });
    expect(first).toContain("otherwise in English, the language of that message");
    // Requests still win: one in the message, or one stored among the durable facts.
    expect(first).toContain("the language the user asked for, if they asked for one — in that message or in the durable facts");
    const later = buildTurnReplyLanguageInstruction(english, "German", { firstTurn: false, userWords: english });
    expect(later).not.toContain("otherwise in English");
    expect(later).toContain("as a standing instruction earlier");
    // A message with no language of its own names no language, only the default.
    const bare = buildTurnReplyLanguageInstruction("ok", "German", { firstTurn: true, userWords: "ok" });
    expect(bare).not.toContain("otherwise in English");
    expect(bare).toContain("(German if there is none)");
  });

  it("names a language only from the words a person typed", () => {
    // A /run scene's template, a scene worker's or a workflow step's task: the swarm wrote it, and on
    // the fresh session such a turn runs in, it is the first turn.
    const template = "Collect the release notes of the configured repositories and summarize what changed this week.";
    const scene = buildTurnReplyLanguageInstruction(template, "German", { firstTurn: true });
    expect(scene).not.toContain("otherwise in English");
    expect(scene).toContain("otherwise in the language of that message");
    // A picture's turn: the analysis ahead of the question is the vision model's, the question the person's.
    const typed = "Was genau bedeutet dieses Schild für mich als Radfahrer?";
    const picture = `${IMAGE_ANALYSIS}\n\n${typed}`;
    expect(buildTurnReplyLanguageInstruction(picture, "German", { firstTurn: true, userWords: typed }))
      .toContain(`otherwise in German, the language of that message (${JSON.stringify(typed)})`);
  });

  it("names none for words in more than one language", () => {
    // Each reads as a whole as one language, and named, that language decided the reply.
    for (const mixed of [
      "Was heißt das genau für mich? \"Refunds are not provided for partial billing periods.\"",
      "Was bedeutet dieser Fehler? Error: Cannot find module 'express'. Require stack: /app/server.js",
      `${IMAGE_ANALYSIS}\n\nWas genau bedeutet dieses Schild für mich als Radfahrer?`,
      // Single quotation marks, in the forms German and English use, around a passage mid-sentence.
      "Was bedeutet 'Refunds are not provided for partial billing periods' für mich?",
      "Was bedeutet ‚Refunds are not provided for partial billing periods‘ für mich?",
      "Was bedeutet ‘Refunds are not provided for partial billing periods’ für mich?",
      "Was meint der Vermieter mit 'the deposit will be withheld until the final inspection is completed'?",
      // A short question ahead of a paste, without quotation marks: on a line of its own, and before a colon.
      "Was heißt das?\nRefunds are not provided for partial billing periods. Please contact our support team if you believe an exception applies.",
      "Übersetze: Refunds are not provided for partial billing periods. Please contact our support team if you believe an exception applies.",
      "Translate this into English: Die Rückerstattung erfolgt nur für volle Abrechnungszeiträume. Bitte wenden Sie sich an unseren Kundendienst.",
      // A comma does not make the question a list.
      "Was heißt das, bitte?\nRefunds are not provided for partial billing periods. Please contact our support team if you believe an exception applies.",
    ]) {
      const line = buildTurnReplyLanguageInstruction(mixed, "German", { firstTurn: true, userWords: mixed });
      expect(line).not.toMatch(/otherwise in [A-Z]\w+, the language/);
      expect(line).toContain("otherwise in the language of that message");
    }
  });

  it("names the language of words in one language with a short phrase or a list in them", () => {
    // Read on its own, a short part is often called another language: "No emojis." Portuguese,
    // "Bullet points." French, "- Pixel 9 Pro" Czech, "Formeller Ton." Danish, "- Olivenöl"
    // Portuguese. Each such call took the first-turn language away from a message in one language.
    for (const [words, language] of [
      ["Write a short LinkedIn post about our new release. Keep it under 100 words. No emojis.", "English"],
      ["Summarize the main arguments for and against remote work. Bullet points.", "English"],
      ["Draft a polite reply to my landlord asking when I will get my deposit back.\n\nCheers, Tom", "English"],
      ["Which of these phones has the best camera?\n- Pixel 9 Pro\n- Galaxy S24 Ultra\n- iPhone 16 Pro", "English"],
      ["Was kann ich heute Abend mit diesen Zutaten kochen?\n- Olivenöl\n- Parmesan\n- Tomaten\n- Spaghetti", "German"],
      ["Schreib eine kurze Absage an den Bewerber. Formeller Ton.", "German"],
    ] as const) {
      expect(buildTurnReplyLanguageInstruction(words, "German", { firstTurn: true, userWords: words }))
        .toContain(`otherwise in ${language}, the language of that message`);
    }
  });

  it("reads a list after a colon together with the request ahead of it", () => {
    // On its own a list of names reads as another language, "Barcelona, Valencia, Sevilla, Granada"
    // as Catalan. Cut off at the colon, it took the first-turn language away from the request.
    for (const [words, language] of [
      ["Rank these programming languages by popularity: Python, JavaScript, Rust, Go, Kotlin", "English"],
      ["Plan a 3-day trip itinerary for these cities: Barcelona, Valencia, Sevilla, Granada", "English"],
      ["Compare the populations of: Kraków, Wrocław, Gdańsk and Poznań", "English"],
      ["Welche dieser Universitäten ist die älteste: Bologna, Salamanca, Coimbra, Padova?", "German"],
    ] as const) {
      expect(buildTurnReplyLanguageInstruction(words, "German", { firstTurn: true, userWords: words }))
        .toContain(`otherwise in ${language}, the language of that message`);
    }
  });

  it("knows a first turn by the history holding no earlier user message", () => {
    expect(isFirstUserTurn([])).toBe(true);
    expect(isFirstUserTurn([{ role: "system" }, { role: "user" }])).toBe(true);
    expect(isFirstUserTurn([{ role: "user" }, { role: "assistant" }, { role: "user" }])).toBe(false);
  });

  it("counts what the person sent while the turn ran, and not the oversight redirect", () => {
    // The redirect is user-role for the model, but nobody wrote it.
    const oversight = { role: "user", metadata: { midTurn: true, midTurnSource: "oversight" } };
    expect(isFirstUserTurn([{ role: "user" }, { role: "assistant" }, oversight])).toBe(true);
    // Their own mid-turn message can carry a request the first-turn line does not list.
    const steering = { role: "user", metadata: { midTurn: true, midTurnSource: "user", steering: [{ id: "s1", text: "Antworte bitte auf Deutsch." }] } };
    expect(isFirstUserTurn([{ role: "user" }, { role: "assistant" }, steering])).toBe(false);
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

  it("gives a bare two-word message one directive, while the full path keeps the language the detector reads", () => {
    // The fast lane's small model answers social turns, and needs the language decided for it.
    expect(String(buildReceptionistMessages("Weather today?", { defaultLanguage: "German" })[0]!.content)).toContain("Reply in GERMAN");
    // The full path answers tasks. Read as the fast lane reads them, a two-word request and a short
    // Chinese or Japanese sentence (no spaces, so one "word") had no language, and opening a
    // conversation they were pointed at the default.
    for (const [message, language] of [
      ["Weather today?", "English"],
      ["如何在冬天储存电池？", "Chinese"],
      ["今日のニュースは？", "Japanese"],
    ] as const) {
      expect(messageHasOwnLanguage(message)).toBe(true);
      const line = buildTurnReplyLanguageInstruction(message, "German", { firstTurn: true, userWords: message });
      expect(line).toContain(`otherwise in ${language}, the language of that message`);
      expect(line).not.toContain("if there is none)");
    }
    // What the detector cannot call has no language on either path.
    expect(messageHasOwnLanguage("ok")).toBe(false);
    expect(messageHasOwnLanguage("你好")).toBe(false);
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

  it("tells a text in one language from a text that changes language", () => {
    expect(detectUniformTextLanguage("Kannst du mir beim Debuggen helfen? Der Server stürzt beim Start ab.")?.name).toBe("German");
    expect(detectUniformTextLanguage("Can you help me debug this issue? The server crashes on startup.")?.name).toBe("English");
    expect(detectUniformTextLanguage("Was heißt das genau für mich? \"Refunds are not provided for partial billing periods.\"")).toBeNull();
    // A question after a long paste: the whole is called from its start, the end is read too.
    const paste = "The European Central Bank kept interest rates unchanged on Thursday, citing persistent inflation. ".repeat(50);
    expect(detectTextLanguage(`${paste}\n\nWas bedeutet das für meinen Kredit?`)?.name).toBe("English");
    expect(detectUniformTextLanguage(`${paste}\n\nWas bedeutet das für meinen Kredit?`)).toBeNull();
    expect(detectUniformTextLanguage("ok")).toBeNull();
    expect(detectUniformTextLanguage(undefined)).toBeNull();
  });

  it("reads the words around a quoted passage together, and an apostrophe as no quotation mark", () => {
    // Around the quote, "Was bedeutet" and "für mich?" are each too short to tell; together they are German.
    expect(detectUniformTextLanguage("Was bedeutet 'Refunds are not provided for partial billing periods' für mich?")).toBeNull();
    // An apostrophe inside the passage does not end it.
    expect(detectUniformTextLanguage("Was bedeutet 'it's not my fault, the delivery was late again' hier genau?")).toBeNull();
    // A quoted term in the text's own language, and apostrophes, leave a text in one language.
    expect(detectUniformTextLanguage("Was ist der Unterschied zwischen 'git merge' und 'git rebase'?")?.name).toBe("German");
    expect(detectUniformTextLanguage("I don't know what the users' settings were. It's been broken since the update.")?.name)
      .toBe("English");
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
