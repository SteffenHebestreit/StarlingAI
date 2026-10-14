import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { localizedFixedText } from "../agent/reply-language.js";
import { TURN_STATUS } from "../agent/turn-status-text.js";
import { executeVisibleTool } from "../agent/visible-tool.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import type { ToolResult } from "../tools/registry.js";

const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..", "agent");

describe("the runtime's narration lines", () => {
  it("have a German and an English form", () => {
    for (const [key, forms] of Object.entries(TURN_STATUS)) {
      expect(forms.de.trim(), key).not.toBe("");
      expect(forms.en.trim(), key).not.toBe("");
      expect(forms.de, key).not.toBe(forms.en);
      // One line, one language: a status once carried both, joined by " / ".
      expect(forms.en, key).not.toContain(" / ");
    }
  });

  it("are said in the language the user wrote in", () => {
    const said = (language: string) => runWithRequestContext({ userMessageLanguage: language }, () => localizedFixedText(TURN_STATUS.finalSynthesis));
    expect(said("German")).toBe(TURN_STATUS.finalSynthesis.de);
    expect(said("English")).toBe(TURN_STATUS.finalSynthesis.en);
  });

  // A German conversation was narrated in English: every line the runtime emitted was a literal.
  it("are never a bare literal at a status site", () => {
    const literal = /onStatus\?\.\(\{[^}]*?message:\s*["'`]/s;
    const offenders = readdirSync(agentDir)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => literal.test(readFileSync(join(agentDir, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("executeVisibleTool", () => {
  const ok: ToolResult = { success: true, output: "[researcher]: done", metadata: { agentName: "researcher" } };

  it("announces a call the runtime makes itself, under the id its history record uses", async () => {
    const events: unknown[][] = [];
    const sink = {
      onToolCall: (...args: unknown[]) => events.push(["call", ...args]),
      onToolResult: (...args: unknown[]) => events.push(["result", ...args]),
    };
    const seen: unknown[] = [];
    const result = await executeVisibleTool(sink, "qareroute_1", "delegate_to_agent", { task: "x" }, {} as never, async (...args) => {
      seen.push(args[3]);
      return ok;
    });
    expect(result).toBe(ok);
    expect(seen).toEqual([{ toolCallId: "qareroute_1" }]);
    expect(events).toEqual([
      ["call", "qareroute_1", "delegate_to_agent", { task: "x" }],
      ["result", "qareroute_1", "delegate_to_agent", "[researcher]: done", { agentName: "researcher" }],
    ]);
  });

  it("reports a failure as the call's result, and still ends the step when the tool throws", async () => {
    const results: string[] = [];
    const sink = { onToolResult: (_id: string, _name: string, text: string) => results.push(text) };
    await executeVisibleTool(sink, "a", "delegate_to_agent", {}, {} as never, async () => ({ success: false, output: "", error: "no agent" }));
    await expect(executeVisibleTool(sink, "b", "delegate_to_agent", {}, {} as never, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(results).toEqual(["Error: no agent", "Error: boom"]);
  });
});
