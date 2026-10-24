import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/registry.js";

/**
 * browser_click asks the page what the click would change before it clicks (browser-form-gate.ts
 * RADIO_CHOICE_FUNCTION through browser_evaluate). E2E 2026-10-23: the page refused Express, and the
 * agent clicked Standard and submitted again.
 */
const page = vi.hoisted(() => ({ checked: "Express", calls: [] as Array<{ name: string; arguments: Record<string, unknown> }> }));
vi.mock("../mcp/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/registry.js")>();
  const target = { type: "object", properties: { element: { type: "string" }, target: { type: "string" } } };
  const connection = {
    tools: [
      { name: "browser_click", inputSchema: target },
      { name: "browser_evaluate", inputSchema: { ...target, properties: { ...target.properties, function: { type: "string" } } } },
    ],
    client: {
      callTool: async (request: { name: string; arguments: Record<string, unknown> }) => {
        page.calls.push(request);
        if (request.name === "browser_evaluate") {
          const option = request.arguments["target"] === "e34" ? "Standard" : "Express";
          const answer = { group: "versand", checked: [page.checked], target: [option], targetChecked: option === page.checked };
          return { content: [{ type: "text", text: `### Result\n${JSON.stringify(answer)}\n### Ran Playwright code` }] };
        }
        return { content: [{ type: "text", text: "### Page\n- Page URL: about:blank" }] };
      },
    },
  };
  return { ...actual, getMcpConnections: () => new Map([["playwright", connection]]) };
});
vi.mock("../tools/browser-watchdog.js", () => ({
  browserWatchdog: async () => ({ noteSuccess: () => undefined, noteFailure: () => null }),
}));

describe("browser_click on a radio button", () => {
  afterEach(() => { page.calls.length = 0; page.checked = "Express"; });

  const clickAs = async (ref: string, opening?: string) => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/multimodal.js");
    const ctx = {
      sessionId: "sub:s1:browser_agent:1",
      workspacePath: "/w",
      ...(opening ? { turnUserWords: { opening, midTurn: [] } } : {}),
    } as ToolContext;
    return getTool("browser_click")!.execute({ element: "Versandart Standard (Radio-Button)", ref }, ctx);
  };
  const clicked = () => page.calls.filter((call) => call.name === "browser_click").map((call) => call.arguments["target"]);

  it("is refused before the browser clicks, when it would replace the user's choice", async () => {
    const result = await clickAs("e34", "Versandart Express, Menge 2.");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Not clicked: "Express" is selected in versand/);
    expect(page.calls.map((call) => call.name)).toEqual(["browser_evaluate"]);
    expect(page.calls[0]!.arguments["target"]).toBe("e34");
    expect(clicked()).toEqual([]);
  });

  it("clicks the user's option, and clicks without asking on a turn no person opened", async () => {
    page.checked = "Standard";
    await clickAs("e35", "Versandart Express, Menge 2.");
    expect(clicked()).toEqual(["e35"]);
    page.calls.length = 0;
    page.checked = "Express";
    await clickAs("e34");
    expect(page.calls.map((call) => call.name)).not.toContain("browser_evaluate");
    expect(clicked()).toEqual(["e34"]);
  });
});
