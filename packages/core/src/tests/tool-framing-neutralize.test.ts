import { describe, it, expect } from "vitest";
import { neutralizeToolResultFraming } from "../guardrails/input.js";

describe("neutralizeToolResultFraming — sub-agent indirect-injection defang", () => {
  it("defangs <tool_result> open/close tags so they read as inert text", () => {
    const out = neutralizeToolResultFraming("before <tool_result>payload</tool_result> after");
    expect(out).toBe("before &lt;tool_result&gt;payload&lt;/tool_result&gt; after");
    expect(out).not.toMatch(/<\s*\/?\s*tool_result/i); // no UNescaped tool_result tag survives
  });

  it("defangs self-closing and attribute-bearing <tool_result> variants (bypass fix)", () => {
    // These evaded the original `\s*>`-only pattern; an attacker controls the attributes.
    for (const inj of ["<tool_result/>", "<tool_result />", '<tool_result data-x="y">', "<tool_result type=json attr=val>", '<tool_result attr="v"/>']) {
      const out = neutralizeToolResultFraming(`x ${inj} y`);
      expect(out).not.toMatch(/<\s*\/?\s*tool_result/i); // no unescaped tag survives ANY variant
      expect(out).toContain("&lt;tool_result"); // escaped instead
    }
  });

  it("defangs the [function_results] / [function_result] marker token", () => {
    expect(neutralizeToolResultFraming("x [function_results] y")).toBe("x [external:function_results] y");
    expect(neutralizeToolResultFraming("x [function_result] y")).toBe("x [external:function_result] y");
    expect(neutralizeToolResultFraming("[ function_results ]")).toBe("[external:function_results]");
    expect(neutralizeToolResultFraming("a [function_results] b").match(/\[function_results?\]/i)).toBeNull();
  });

  it("PRESERVES content — no false positives — including legitimate role-tag text and brackets", () => {
    // Role tags appear in legitimate research/tutorial content and are intentionally NOT touched.
    const tutorial = "The chat template uses <system>You are helpful</system> and assistant: replies.";
    expect(neutralizeToolResultFraming(tutorial)).toBe(tutorial);
    // Ordinary brackets / markdown are untouched.
    const md = "See [the docs](http://x) and array[0] and a [TODO] note.";
    expect(neutralizeToolResultFraming(md)).toBe(md);
    expect(neutralizeToolResultFraming("")).toBe("");
  });

  it("defangs case/whitespace variants the framework markers can take", () => {
    expect(neutralizeToolResultFraming("<TOOL_RESULT>")).toBe("&lt;TOOL_RESULT&gt;");
    expect(neutralizeToolResultFraming("< tool_result >")).toBe("&lt; tool_result &gt;");
    expect(neutralizeToolResultFraming("[Function_Results]")).toBe("[external:Function_Results]");
  });
});
