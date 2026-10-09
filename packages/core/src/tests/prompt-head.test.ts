/**
 * The head hashes on provider_model_call, sub_agent_head and prompt_section_sizes
 * (providers/prompt-head.ts). They are only worth logging if they separate exactly what the
 * serving model's cache separates: the same bytes give the same hash, and anything the chat
 * template renders into the prompt head — the system text, a tool's name, its description, the
 * ORDER of the tool block — gives a different one. A tool reorder alone is a full cold prefill
 * (46.72 s against 0.43 s, sub-agent.ts rerank comment); a hash that ignored order would call
 * that call "the same head, evicted".
 */
import { describe, expect, it } from "vitest";
import { hashText, hashToolBlock, promptHeadSignature, wireHeadSignature, type HeadTool } from "../providers/prompt-head.js";

const tool = (name: string, description = `${name} does one thing`): HeadTool => ({
  name,
  description,
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
});

const SYSTEM = "You are the main assistant.\n\nRules paragraph.";
const TOOLS = [tool("delegate_to_agent"), tool("record_plan"), tool("search_agents")];

describe("prompt head signature", () => {
  it("gives the same hashes for the same bytes, built separately", () => {
    const a = promptHeadSignature(SYSTEM, TOOLS);
    const b = promptHeadSignature(`${"You are the main assistant."}\n\nRules paragraph.`, TOOLS.map((t) => ({ ...t, parameters: JSON.parse(JSON.stringify(t.parameters)) })));
    expect(b).toEqual(a);
    expect(a.headHash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.systemChars).toBe(SYSTEM.length);
    expect(a.toolCount).toBe(3);
  });

  it("changes headHash and toolsHash when only the tool ORDER changes, and keeps systemHash", () => {
    const a = promptHeadSignature(SYSTEM, TOOLS);
    const reordered = promptHeadSignature(SYSTEM, [TOOLS[1]!, TOOLS[0]!, TOOLS[2]!]);
    expect(reordered.toolsHash).not.toBe(a.toolsHash);
    expect(reordered.headHash).not.toBe(a.headHash);
    expect(reordered.systemHash).toBe(a.systemHash);
  });

  it("changes headHash and systemHash when only the system text changes, and keeps toolsHash", () => {
    const a = promptHeadSignature(SYSTEM, TOOLS);
    const changed = promptHeadSignature(`${SYSTEM} `, TOOLS);
    expect(changed.systemHash).not.toBe(a.systemHash);
    expect(changed.headHash).not.toBe(a.headHash);
    expect(changed.toolsHash).toBe(a.toolsHash);
  });

  it("sees a reworded description or a changed schema, which the template renders too", () => {
    const base = hashToolBlock(TOOLS);
    expect(hashToolBlock([tool("delegate_to_agent", "reworded"), TOOLS[1]!, TOOLS[2]!])).not.toBe(base);
    expect(hashToolBlock([{ ...TOOLS[0]!, parameters: { type: "object", properties: {} } }, TOOLS[1]!, TOOLS[2]!])).not.toBe(base);
    // The forced subset is a different block, which is the point of logging toolsHash per call.
    expect(hashToolBlock(TOOLS.slice(0, 2))).not.toBe(base);
  });

  it("cannot be fooled by moving text between the system part and the tool block", () => {
    // headHash hashes the two parts' own hashes, not their concatenation, so bytes that move from
    // one part to the other are a different head.
    const a = promptHeadSignature("ab", [tool("c")]);
    const b = promptHeadSignature("a", [tool("bc")]);
    expect(a.headHash).not.toBe(b.headHash);
  });

  it("reads the system part off a wire request's leading system message", () => {
    const wire = wireHeadSignature([{ role: "system", content: SYSTEM }, { role: "user", content: "." }], TOOLS);
    expect(wire).toEqual(promptHeadSignature(SYSTEM, TOOLS));
    // A template without a system role folds it into the user turn: the system part is empty.
    const noSystem = wireHeadSignature([{ role: "user", content: `${SYSTEM}\n\nhi` }], TOOLS);
    expect(noSystem.systemHash).toBe(hashText(""));
    expect(noSystem.systemChars).toBe(0);
  });

  it("covers every leading system message: gpt-oss gets its Reasoning line as a message of its own", () => {
    // lmstudio.ts withReasoningSystemLine puts `Reasoning: <level>` AHEAD of the folded system
    // message. Hashing only messages[0] made every gpt-oss call at one level the same "system",
    // whatever the prompt behind it said.
    const gptOss = (text: string) => wireHeadSignature([
      { role: "system", content: "Reasoning: low" },
      { role: "system", content: text },
      { role: "user", content: "." },
    ], TOOLS);
    expect(gptOss("You are agent A.").systemHash).not.toBe(gptOss("You are agent B.").systemHash);
    expect(gptOss("You are agent A.").systemChars).toBe("Reasoning: low\n\nYou are agent A.".length);
    // One leading system message hashes exactly as before, so the other rows still join.
    expect(wireHeadSignature([{ role: "system", content: SYSTEM }], TOOLS).systemHash).toBe(hashText(SYSTEM));
  });
});
