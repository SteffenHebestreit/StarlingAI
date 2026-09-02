import { describe, expect, it } from "vitest";
import { composeTurnMessages } from "../agent/turn-system-prompt.js";
import { tierModelDefaults } from "../providers/index.js";
import type { LLMMessage } from "../providers/lmstudio.js";

/**
 * THE LEADING SYSTEM RUN IS THE KV-CACHE KEY.
 *
 * The LM Studio provider folds every leading system message into one, the chat template renders
 * the ~9K-token tool block right behind it, and llama.cpp reuses the cache only for the longest
 * unchanged prefix. The head used to carry segments that exist only on iteration 0 (language,
 * plan nudge, discovery capsule) or only afterwards (shared findings), so it was byte-different on
 * every iteration and the tool block plus the whole history re-prefilled each time. Measured on
 * the deployment: identical prefix 1,356 ms; 200 varying characters ahead of it 6,251 ms.
 */
describe("composeTurnMessages — where per-turn guidance is placed", () => {
  const head: LLMMessage[] = [
    { role: "system", content: "BASE" },
    { role: "system", content: "DATE" },
  ];
  const history: LLMMessage[] = [{ role: "user", content: "hello" }];
  const guidanceIter0: LLMMessage[] = [
    { role: "system", content: "LANGUAGE" },
    { role: "system", content: "PLAN FIRST" },
  ];
  const guidanceIter1: LLMMessage[] = [{ role: "system", content: "[SHARED FINDINGS]" }];

  it("keeps the leading system run identical across iterations when stable", () => {
    const leadingRun = (messages: LLMMessage[]): string => {
      const run: string[] = [];
      for (const m of messages) {
        if (m.role !== "system") break;
        run.push(String(m.content));
      }
      return run.join("\n\n");
    };
    const iter0 = composeTurnMessages(head, history, guidanceIter0, true);
    const iter1 = composeTurnMessages(head, history, guidanceIter1, true);
    expect(leadingRun(iter0)).toBe(leadingRun(iter1));   // the cache key survives the iteration
    expect(leadingRun(iter0)).toBe("BASE\n\nDATE");
  });

  it("still delivers the guidance — after the history, as the most recent context", () => {
    const out = composeTurnMessages(head, history, guidanceIter0, true);
    expect(out.map((m) => m.content)).toEqual(["BASE", "DATE", "hello", "LANGUAGE", "PLAN FIRST"]);
  });

  it("restores the previous all-leading shape when the flag is off", () => {
    const out = composeTurnMessages(head, history, guidanceIter0, false);
    expect(out.map((m) => m.content)).toEqual(["BASE", "DATE", "LANGUAGE", "PLAN FIRST", "hello"]);
  });
});

/**
 * The routing tier exists for yes/no verdicts. Inheriting the default model's thinking made each
 * of them reason first — 6.1 s and ~1,000 reasoning characters per verdict on the single GPU,
 * serialized before the user's first token.
 */
describe("tierModelDefaults — routing verdicts do not think", () => {
  it("turns thinking off for the routing tier, both ways, so it survives a model swap", () => {
    // qwen3.6 honours only enableThinking; qwen3.8+ honours only reasoningEffort.
    expect(tierModelDefaults("routing")).toEqual({ enableThinking: false, reasoningEffort: "none" });
  });

  it("leaves the synthesis tier alone", () => {
    expect(tierModelDefaults("synthesis")).toEqual({});
  });

  it("is a default, not a ceiling — a caller's override wins", () => {
    const merged = { ...tierModelDefaults("routing"), ...{ enableThinking: true } };
    expect(merged.enableThinking).toBe(true);
  });
});
