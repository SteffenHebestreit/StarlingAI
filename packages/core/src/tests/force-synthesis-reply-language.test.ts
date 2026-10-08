import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MID_TURN_SOURCE_METADATA,
  MID_TURN_USER_MESSAGE_METADATA,
  STEERING_METADATA,
  STEERING_PREFIX,
} from "../agent/turn-boundary.js";

/**
 * A forced synthesis carries the turn's reply-language line (2026-10-07).
 *
 * It writes the final answer from the system prompt and the conversation, and the system prompt's
 * rule names no default language any more (reply-language.ts). The line names the default for a
 * message with no language of its own; for any other message it restates the precedence only.
 */

const sentMessages = vi.hoisted(() => [] as Array<Array<{ role: string; content: unknown }>>);
const completeMock = vi.hoisted(() => vi.fn(async (messages: Array<{ role: string; content: unknown }>) => {
  sentMessages.push(messages);
  return { content: "final answer", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
}));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    stream: () => (async function* () { /* unused */ })(),
    complete: completeMock,
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: Record<string, unknown>) => model,
    tierModelDefaults: () => ({}),
    createChatProvider: () => provider,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => provider,
  };
});
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

type SeedMessage = { role: "user" | "assistant" | "tool"; content: string; metadata?: Record<string, unknown> };

/**
 * The RESPOND NOW message a forced synthesis sends for `userMessage`'s turn. `before` is the
 * conversation before that turn; `during` is what the turn added after its first tool result.
 */
async function synthesizeAfter(userMessage: string, opts: { before?: SeedMessage[]; during?: SeedMessage[] } = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sai-synthesis-language-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { defaultLanguage: "German" } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  await (await import("../agent/text-language.js")).warmTextLanguageDetector();
  const { AgentSession } = await import("../agent/session.js");
  const { forceSynthesis } = await import("../agent/runtime.js");

  const session = new AgentSession({ channel: "test", workspacePath: dir, systemPrompt: "You are a test agent." });
  for (const message of opts.before ?? []) session.addMessage(message);
  session.addMessage({ role: "user", content: userMessage });
  session.addMessage({ role: "assistant", content: "…" });
  session.addMessage({ role: "tool", content: "evidence: store batteries cool, at 40-60 % charge" });
  for (const message of opts.during ?? []) session.addMessage(message);
  await forceSynthesis(session, { complete: completeMock } as never, new AbortController().signal, "Write the final answer.");

  const last = sentMessages.at(-1)?.at(-1);
  return typeof last?.content === "string" ? last.content : "";
}

const GERMAN_QUESTION = "Wie lagere ich die Akkus meiner Elektrowerkzeuge im Winter am besten? Bitte ausführlich.";
const ENGLISH_QUESTION = "How should I store the batteries of my power tools over the winter?";

/** What the runtime writes into history when the person steers a running turn (runtime.ts). */
const STEERING: SeedMessage = {
  role: "user",
  content: `${STEERING_PREFIX} The user added the following while you were working. Take it into account in the REMAINING `
    + "steps of this turn: adjust course, drop now-irrelevant work, and prioritise it. Do not restart from scratch or "
    + "re-do already-completed steps.\n- Bitte nur die drei wichtigsten Punkte.",
  metadata: {
    [MID_TURN_USER_MESSAGE_METADATA]: true,
    [MID_TURN_SOURCE_METADATA]: "user",
    [STEERING_METADATA]: [{ id: "steer-1", text: "Bitte nur die drei wichtigsten Punkte." }],
  },
};

/** What the max-effort progress monitor writes into history when it redirects a turn (runtime.ts). */
const OVERSIGHT: SeedMessage = {
  role: "user",
  content: "[OVERSIGHT — max-effort progress check] A progress monitor judged this turn is not converging on the "
    + "deliverable. Apply this correction in your NEXT step — do NOT restart from scratch or re-do finished work:\n"
    + "Answer from the evidence already gathered instead of delegating again.",
  metadata: { [MID_TURN_USER_MESSAGE_METADATA]: true, [MID_TURN_SOURCE_METADATA]: "oversight" },
};

describe("forced synthesis reply language", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    sentMessages.length = 0;
    completeMock.mockClear();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("names the default language for a message with no language of its own", async () => {
    const instruction = await synthesizeAfter("https://example.com/winter-battery-storage");
    expect(instruction).toContain("[SYSTEM INSTRUCTION — RESPOND NOW]");
    expect(instruction).toContain("(German if there is none)");
  });

  it("restates the precedence, and names no default, for any other message", async () => {
    const instruction = await synthesizeAfter(ENGLISH_QUESTION);
    expect(instruction).toContain("Reply in the language the user asked for");
    expect(instruction).not.toContain("if there is none)");
  });

  it("names the message's language on the conversation's first turn, and on no later one", async () => {
    // Unnamed, an English first question came back German 5 times in 12 (2026-10-07). Both wordings
    // restate the precedence, so only the named language tells the two apart.
    expect(await synthesizeAfter(ENGLISH_QUESTION)).toContain("otherwise in English, the language of that message");
    const later = await synthesizeAfter(ENGLISH_QUESTION, {
      before: [
        { role: "user", content: "Wie spät ist es gerade in Tokio?" },
        { role: "assistant", content: "In Tokio ist es gerade neun Uhr morgens." },
      ],
    });
    expect(later).toContain("as a standing instruction earlier");
    expect(later).not.toContain("otherwise in English");
  });

  it("quotes the turn's own message, not the frame its mid-turn steering came in", async () => {
    // The frame reads as English, and the quote cut the person's words to "Bitte nur die".
    const instruction = await synthesizeAfter(GERMAN_QUESTION, { during: [STEERING] });
    expect(instruction).not.toContain(STEERING_PREFIX);
    expect(instruction).toContain("the language of that message (\"Wie lagere ich");
  });

  it("quotes the turn's own message past an oversight redirect, which ends no first turn", async () => {
    // The redirect is user-role for the model, but nobody wrote it: the first turn stays a first turn.
    const instruction = await synthesizeAfter(GERMAN_QUESTION, { during: [OVERSIGHT] });
    expect(instruction).not.toContain("[OVERSIGHT");
    expect(instruction).toContain("otherwise in German, the language of that message (\"Wie lagere ich");
  });
});
