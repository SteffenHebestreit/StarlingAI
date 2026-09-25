/**
 * laya-browser driving inside a real sub-agent run: a step it is sure of replaces that iteration's
 * model call, runs as the agent's own browser_click through the tool pipeline, is shown to the
 * model as its call, and does not use up one of the model's iterations. The model, the Playwright
 * MCP server and the laya sidecar are fakes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.fn();
const playwrightCalls = vi.hoisted(() => [] as Array<{ name: string; arguments: Record<string, unknown> }>);

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

const PRODUCTS_PATH = "html > body:nth-child(2) > nav:nth-child(1) > a:nth-child(2)";

vi.mock("../mcp/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../mcp/registry.js")>();
  let onPage: "none" | "home" | "products" = "none";
  const observation = (where: "home" | "products") => ({
    url: `https://93.184.215.14/${where}`,
    title: where,
    text: where === "home" ? "Welcome" : "Chair 49 EUR",
    scroll: { y: 0, height: 700 },
    actions: where === "home"
      ? [{ id: "e1", node: 1, role: "link", label: "Home", kind: "click", value: "" }, { id: "e2", node: 2, role: "link", label: "Products", kind: "click", value: "" }]
      : [{ id: "e1", node: 5, role: "link", label: "Chair", kind: "click", value: "" }],
  });
  const text = (body: string) => ({ content: [{ type: "text", text: body }] });
  const client = {
    async callTool({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) {
      playwrightCalls.push({ name, arguments: args });
      if (name === "browser_navigate") {
        onPage = "home";
        return text("### Page\n- Page URL: https://93.184.215.14/home\n### Snapshot\n```yaml\n- link \"Home\" [ref=e3]\n- link \"Products\" [ref=e4]\n```");
      }
      if (name === "browser_click") {
        if (args["target"] === PRODUCTS_PATH) onPage = "products";
        return text("### Page\n- Page URL: https://93.184.215.14/products\n### Snapshot\n```yaml\n- link \"Chair\" [ref=e9]\n- text: Chair 49 EUR\n```");
      }
      if (name === "browser_evaluate" && onPage !== "none") {
        const targets = onPage === "home" ? { 1: { path: "html > body:nth-child(2) > nav:nth-child(1) > a:nth-child(1)" }, 2: { path: PRODUCTS_PATH } } : { 5: { path: "html > body:nth-child(2) > a:nth-child(1)" } };
        return text(`### Result\n${JSON.stringify({ observation: observation(onPage), targets }, null, 2)}\n### Ran Playwright code\n\`\`\`js\nawait page.evaluate('…');\n\`\`\``);
      }
      return { content: [{ type: "text", text: `### Error\nunexpected ${name}` }], isError: true };
    },
  };
  const schema = (...keys: string[]) => ({ type: "object", properties: Object.fromEntries(keys.map((key) => [key, { type: "string" }])) });
  const connection = {
    serverName: "playwright",
    client,
    tools: [
      { name: "browser_navigate", inputSchema: schema("url") },
      { name: "browser_click", inputSchema: schema("element", "target") },
      { name: "browser_select_option", inputSchema: schema("element", "target", "values") },
      { name: "browser_snapshot", inputSchema: schema() },
      { name: "browser_evaluate", inputSchema: schema("function", "element", "target") },
    ],
    async disconnect() { /* fake */ },
  };
  return { ...actual, getMcpConnections: () => new Map([["playwright", connection]]) };
});

describe("laya-browser driving a sub-agent run", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    playwrightCalls.length = 0;
    vi.unstubAllGlobals();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  it("takes the click it is sure of in place of a model call, and gives the model its iteration back", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-browser-drive-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        web_clicker: {
          description: "Clicks through websites",
          systemPrompt: "Use the browser tools.",
          tools: ["browser_navigate", "browser_click", "browser_snapshot"],
          maxIterations: 4,
        },
      },
      decisions: {
        baseUrl: "http://laya:8080",
        ledger: { path: join(tempDir, "decisions", "ledger.jsonl") },
        browser: { mode: "drive" },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await import("../tools/sub-agent.js");
    await import("../tools/multimodal.js");

    const layaAsked: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).endsWith("/v1/browser/step")) return new Response("{}", { status: 404 });
      layaAsked.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const onHome = String((layaAsked.at(-1)!["observation"] as { url: string }).url).endsWith("/home");
      const answer = onHome
        ? {
          operation: "CLICK", operationProbability: 0.97, operationProbabilities: { CLICK: 0.97, DONE: 0.03 },
          target: { index: "2", actionId: "e2", node: 2, kind: "click", label: "Products", role: "link", probability: 0.96, alternatives: [] },
          control: null,
        }
        : { operation: "DONE", operationProbability: 0.9, operationProbabilities: { DONE: 0.9, CLICK: 0.1 }, target: null, control: null };
      return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const modelCalls: Array<Array<{ role: string; content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>> = [];
    completeMock.mockImplementation((messages: never) => {
      modelCalls.push(messages);
      const call = modelCalls.length === 1
        ? { content: "", tool_calls: [{ id: "nav-1", name: "browser_navigate", arguments: { url: "https://93.184.215.14/home" } }] }
        : modelCalls.length === 2
          ? { content: "", tool_calls: [{ id: "click-1", name: "browser_click", arguments: { element: "Chair", ref: "e9" } }] }
          : { content: "The chair costs 49 EUR.", tool_calls: [] };
      return Promise.resolve({ ...call, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: call.tool_calls.length ? "tool_calls" : "stop" });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "web_clicker",
        task: "Open the shop and find the price of the chair.",
        parentSessionId: "parent-browser-drive",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("49 EUR");
      // Navigate (model), Products (laya-browser, no model call), Chair (model), answer (model).
      expect(modelCalls).toHaveLength(3);
      const click = playwrightCalls.find((call) => call.name === "browser_click");
      expect(click?.arguments).toEqual({ element: "Products (link) — picked by the fast browser model, 96% sure", target: PRODUCTS_PATH });
      // The model reads the click as a call of its run, marked as laya-browser's, and the page it led to.
      const seen = modelCalls[1]!;
      const assistantClick = seen.find((m) => m.role === "assistant" && m.tool_calls?.[0]?.function.name === "browser_click");
      expect(assistantClick?.tool_calls?.[0]?.function.arguments).toContain("picked by the fast browser model");
      expect(seen.some((m) => m.role === "tool" && String(m.content).includes("Chair 49 EUR"))).toBe(true);
      // Iteration 3 of 4 would have warned the model it had two left; the driven step gave one back.
      expect(seen.map((m) => String(m.content ?? "")).join("\n")).not.toContain("BUDGET WARNING");
      expect(layaAsked[0]!["goal"]).toBe("Open the shop and find the price of the chair.");

      // The ledger: laya-browser's own click, the model's click against laya-browser's DONE, and
      // the model's answer against it — each with the page as it was read.
      const ledgerPath = join(tempDir, "decisions", "browser-ledger.jsonl");
      const rows = async () => {
        await (await import("../decisions/ledger.js")).flushLedgerForTests();
        return existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
      };
      await vi.waitFor(async () => expect(await rows()).toHaveLength(3));
      const ledger = await rows();
      expect(ledger.map((row) => [row["decidedBy"], (row["model"] as { tool?: string } | null)?.tool ?? null])).toEqual([
        ["laya", null],
        ["model", "browser_click"],
        ["model", "final_answer"],
      ]);
      expect(ledger[1]).toMatchObject({ model: { operation: "CLICK", node: 5, found: "name" }, laya: { operation: "DONE" }, agree: { operation: false } });
      expect(ledger[2]).toMatchObject({ agree: { operation: true } });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
