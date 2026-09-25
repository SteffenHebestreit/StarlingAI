/**
 * Playwright MCP 1.61 changed the shape of its answers: a "### Page" header over the URL and
 * title, "### Snapshot" with the yaml tree (or, after an action, a link to a file holding it) and
 * "### Ran Playwright code" with the code it ran. Shared findings strip the old "### Page state"
 * shape; the new one went through whole — a page's accessibility tree and Playwright code stored
 * as "facts" for every other specialist to read.
 */
import { describe, expect, it } from "vitest";
import { extractKeyFacts } from "../tools/result-shaping.js";

const CLICK_ANSWER = [
  "### Ran Playwright code",
  "```js",
  "await page.getByRole('button', { name: 'Show prices' }).click();",
  "```",
  "### Page",
  "- Page URL: https://shop.example.com/pricing",
  "- Page Title: Pricing",
  "### Snapshot",
  "```yaml",
  "- generic [ref=e1]:",
  "  - heading \"Plans\" [level=1] [ref=e2]",
  "  - button \"Buy\" [ref=e9] [cursor=pointer]",
  "```",
  "Basic costs 9 EUR per month; Pro costs 29 EUR per month.",
].join("\n");

describe("shared findings from Playwright MCP 1.61 answers", () => {
  it("keep the page's facts and drop its tree, the code that ran and the headers", () => {
    const facts = extractKeyFacts(CLICK_ANSWER, "browser_click");
    expect(facts).toContain("Basic costs 9 EUR per month; Pro costs 29 EUR per month.");
    for (const scaffolding of ["[ref=", "### Snapshot", "Ran Playwright code", "getByRole", "```", "### Page", "Page Title"]) {
      expect(facts, scaffolding).not.toContain(scaffolding);
    }
  });

  it("drop the link an action answers with in place of the tree", () => {
    const facts = extractKeyFacts(
      "### Page\n- Page URL: https://shop.example.com/\n### Snapshot\n- [Snapshot](.playwright-mcp/page-2026-09-25T19-55-09-899Z.yml)\nIn stock: 3 units.",
      "browser_navigate",
    );
    expect(facts).toBe("In stock: 3 units.");
  });
});
