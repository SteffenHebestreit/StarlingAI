import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

async function synthesizeAfter(userMessage: string): Promise<string> {
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
  session.addMessage({ role: "user", content: userMessage });
  session.addMessage({ role: "assistant", content: "…" });
  session.addMessage({ role: "tool", content: "evidence: store batteries cool, at 40-60 % charge" });
  await forceSynthesis(session, { complete: completeMock } as never, new AbortController().signal, "Write the final answer.");

  const last = sentMessages.at(-1)?.at(-1);
  return typeof last?.content === "string" ? last.content : "";
}

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
    const instruction = await synthesizeAfter("How should I store the batteries of my power tools over the winter?");
    expect(instruction).toContain("Reply in the language the user asked for");
    expect(instruction).not.toContain("if there is none)");
  });
});
