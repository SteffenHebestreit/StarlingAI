import { describe, expect, it, vi } from "vitest";
import { distillFindingForSharedFacts } from "../agent/sub-agent.js";
import type { ChatProvider, LLMMessage } from "../providers/lmstudio.js";

/**
 * Auto-share distillation (user request, May 2026). Instead of storing the heuristic
 * extract of a large tool result verbatim, hand the agent's OBJECTIVE plus the raw
 * found content to a one-shot model pass that keeps only the objective-relevant
 * facts/URLs. This minimizes noise in shared facts and shrinks the context the final
 * synthesis must read. The pass must surface what it found, signal "" when nothing was
 * relevant (so the caller skips the share), and return null on failure (so the caller
 * keeps the heuristic extract — never drops evidence).
 */
const fakeProvider = (impl: () => Promise<{ content: string }> | { content: string }): ChatProvider => ({
  complete: vi.fn(async (_messages: LLMMessage[]) => {
    const r = await impl();
    return { content: r.content, tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }),
} as unknown as ChatProvider);

describe("distillFindingForSharedFacts", () => {
  it("returns the distilled, objective-relevant bullets", async () => {
    const provider = fakeProvider(() => ({
      content: "- Zwinger built 1709–1728 by Matthäus Daniel Pöppelmann\n- Source: https://en.wikipedia.org/wiki/Zwinger",
    }));
    const out = await distillFindingForSharedFacts({
      objective: "Baugeschichte des Dresdner Zwinger mit Quellen",
      toolName: "web_fetch",
      rawEvidence: "Zwinger - Wikipedia Jump to content Main menu ... The Zwinger was built between 1709 and 1728 ...",
      provider,
    });
    expect(out).toContain("Pöppelmann");
    expect(out).toContain("https://en.wikipedia.org/wiki/Zwinger");
  });

  it("returns \"\" when the model reports nothing relevant (NONE)", async () => {
    const provider = fakeProvider(() => ({ content: "NONE" }));
    const out = await distillFindingForSharedFacts({
      objective: "MEMS microphone pricing",
      toolName: "web_fetch",
      rawEvidence: "Cookie settings Privacy policy Newsletter subscribe Skip to content Log in Home About",
      provider,
    });
    expect(out).toBe("");
  });

  it("returns null on provider failure (caller keeps the heuristic extract)", async () => {
    const provider = fakeProvider(() => { throw new Error("model timeout"); });
    const out = await distillFindingForSharedFacts({
      objective: "anything",
      toolName: "web_search",
      rawEvidence: "x".repeat(400),
      provider,
    });
    expect(out).toBeNull();
  });

  it("passes the objective and raw content to the model", async () => {
    const complete = vi.fn(async () => ({ content: "- fact", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }));
    const provider = { complete } as unknown as ChatProvider;
    await distillFindingForSharedFacts({
      objective: "find the SNR spec",
      toolName: "web_fetch",
      rawEvidence: "The SNR is 73 dB(A).",
      provider,
    });
    const firstCall = complete.mock.calls[0] as unknown as [LLMMessage[]];
    const messages = firstCall[0];
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("find the SNR spec");
    expect(userMsg).toContain("73 dB(A)");
  });
});
