import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as loaderModule from "../config/loader.js";
import type { ToolContext } from "../tools/registry.js";

const mcpConnections = new Map<string, unknown>();
vi.mock("../mcp/registry.js", () => ({
  getMcpConnections: () => mcpConnections,
}));

// A name on the operator's LAN for the allowlist cases: it resolves to a private address, and
// every lookup of it is counted. Every other lookup is the real one.
const { LAN_HOST, LAN_ADDRESS, lanLookups } = vi.hoisted(() => ({
  LAN_HOST: "wiki.lan.example",
  LAN_ADDRESS: "172.22.0.14",
  lanLookups: [] as string[],
}));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = (hostname: string, options?: unknown) => {
    if (hostname !== LAN_HOST) return actual.lookup(hostname, options as never);
    lanLookups.push(hostname);
    return Promise.resolve([{ address: LAN_ADDRESS, family: 4 }]);
  };
  return { ...actual, lookup };
});

/**
 * The browser tools guarded only the URL they were given. A redirect, the page's own script or a
 * click then moved the browser with nothing checking where, and the next answer carried that
 * page: browser_navigate to a public URL that redirected to http://10.0.0.5/ returned the
 * internal page's snapshot. Every answer that reports a Page URL is now checked against the guard.
 */
describe("browser tools refuse to show a page on a host the SSRF guard refuses", () => {
  // An IP literal: the SSRF guard needs no DNS for it.
  const PUBLIC = "http://93.184.215.14";
  const INTERNAL = "Jenkins credentials: deploy-key-prod";
  const ctx: ToolContext = { sessionId: "session-browser-page-guard", workspacePath: "/workspace" };

  beforeAll(async () => {
    await import("../tools/multimodal.js");
    await import("../tools/accessibility.js");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mcpConnections.clear();
    lanLookups.length = 0;
  });

  async function tool(name: string) {
    const { getTool } = await import("../tools/registry.js");
    const handler = getTool(name);
    if (!handler) throw new Error(`${name} is not registered`);
    return handler;
  }

  /** Playwright MCP answering each tool with `answers[name]`, and with nothing otherwise. */
  function browser(answers: Record<string, string>) {
    const callTool = vi.fn(async (input: { name: string; arguments: Record<string, unknown> }) => ({
      content: [{ type: "text", text: answers[input.name] ?? "" }],
      isError: false,
    }));
    mcpConnections.set("playwright", { client: { callTool } });
    return callTool;
  }

  const calls = (callTool: ReturnType<typeof browser>) => callTool.mock.calls.map(([input]) =>
    input.name === "browser_navigate" ? `navigate ${String(input.arguments["url"])}` : input.name);

  /** A Playwright MCP answer for a page at `url` showing `text`. */
  const page = (url: string, text = INTERNAL) =>
    `### Page\n- Page URL: ${url}\n- Page Title: Seite\n### Snapshot\n\`\`\`yaml\n- text: ${text}\n\`\`\``;

  function allowPrivateHosts(hosts: string[]) {
    const realConfig = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      guardrails: { ...realConfig.guardrails, allowedPrivateHosts: hosts },
    } as typeof realConfig);
  }

  it("refuses a navigation that ended on a private host, and sends the tab to about:blank", async () => {
    const callTool = browser({ browser_navigate: page("http://10.0.0.5/") });

    const r = await (await tool("browser_navigate")).execute({ url: `${PUBLIC}/weiter` }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to show the page the browser is on: requesting private/internal network addresses is not allowed. The browser was sent to about:blank.");
    expect(JSON.stringify(r)).not.toContain(INTERNAL);
    expect(calls(callTool)).toEqual([`navigate ${PUBLIC}/weiter`, "navigate about:blank"]);
  });

  it("refuses an action whose page had moved on to a private host when the snapshot was taken", async () => {
    const callTool = browser({
      browser_click: "### Ran Playwright code\n```js\nawait page.getByRole('link', { name: 'Weiter' }).click();\n```\n"
        + `### Page\n- Page URL: ${PUBLIC}/start\n- Page Title: Start\n### Snapshot\n- [Snapshot](.playwright-mcp/page-2026-10-08T10-00-00-000Z.yml)`,
      browser_snapshot: page("http://192.168.1.20/router"),
    });

    const r = await (await tool("browser_click")).execute({ element: "Weiter", ref: "e3" }, ctx);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toContain(INTERNAL);
    expect(calls(callTool)).toEqual(["browser_click", "browser_snapshot", "navigate about:blank"]);
  });

  it("leaves an answer on a public page exactly as it was", async () => {
    const answer = page(`${PUBLIC}/katalog`, "Katalog: 18 Artikel in sechs Kategorien");
    const callTool = browser({ browser_snapshot: answer });

    const r = await (await tool("browser_snapshot")).execute({}, ctx);
    expect(r).toEqual({ success: true, output: answer, metadata: { server: "playwright", tool: "browser_snapshot" } });
    expect(calls(callTool)).toEqual(["browser_snapshot"]);
  });

  it.each([
    ["a blob: page", "blob:http://10.0.0.5/9f1c2d3e-0b5c-4f00-8a00-0000000000a1"],
    ["a view-source: page", "view-source:http://10.0.0.5/admin"],
  ])("refuses %s whose URL inside is on a private host", async (_label, pageUrl) => {
    const callTool = browser({ browser_snapshot: page(pageUrl) });

    const r = await (await tool("browser_snapshot")).execute({}, ctx);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toContain(INTERNAL);
    expect(calls(callTool)).toEqual(["browser_snapshot", "navigate about:blank"]);
  });

  it("shows a blob: page whose URL inside is public", async () => {
    const answer = page(`blob:${PUBLIC}/9f1c2d3e-0b5c-4f00-8a00-0000000000a2`, "Export: 18 Artikel");
    const callTool = browser({ browser_snapshot: answer });

    const r = await (await tool("browser_snapshot")).execute({}, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toBe(answer);
    expect(calls(callTool)).toEqual(["browser_snapshot"]);
  });

  it("refuses a page on a LAN name that resolves to a private address when it is not listed", async () => {
    const callTool = browser({ browser_snapshot: page(`http://${LAN_HOST}/b`) });

    const r = await (await tool("browser_snapshot")).execute({}, ctx);
    expect(r.success).toBe(false);
    expect(calls(callTool)).toEqual(["browser_snapshot", "navigate about:blank"]);
  });

  it("shows that page unchanged when guardrails.allowedPrivateHosts lists the name", async () => {
    allowPrivateHosts([LAN_HOST]);
    const answer = page(`http://${LAN_HOST}/a`, "Wiki: Betriebshandbuch");
    const callTool = browser({ browser_snapshot: answer });

    const r = await (await tool("browser_snapshot")).execute({}, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toBe(answer);
    expect(calls(callTool)).toEqual(["browser_snapshot"]);
  });

  it("checks a page once, not again for every answer while the browser stays on it", async () => {
    allowPrivateHosts([LAN_HOST]);
    browser({ browser_snapshot: page(`http://${LAN_HOST}/c`, "Wiki: Wartungsplan") });
    const snapshot = await tool("browser_snapshot");

    expect((await snapshot.execute({}, ctx)).success).toBe(true);
    expect((await snapshot.execute({}, ctx)).success).toBe(true);
    expect(lanLookups).toEqual([LAN_HOST]);
  });

  /** browser_evaluate's answer for the axe audit, run on the page at `url`. */
  const axeResult = (url: string) => `### Result\n${JSON.stringify({
    url,
    testEngine: { name: "axe-core", version: "4.10.2" },
    violations: [{
      id: "label", impact: "critical", help: "Form elements must have labels", helpUrl: "https://dequeuniversity.com/rules/axe/4.10/label",
      tags: ["wcag2a"], nodes: [{ target: ["#deploy-key-field"] }], nodeCount: 1,
    }],
    incomplete: [],
  })}`;

  it("browser_axe_audit refuses a navigation that ended on a private host, before auditing it", async () => {
    const callTool = browser({ browser_navigate: page("http://10.0.0.5/") });

    const r = await (await tool("browser_axe_audit")).execute({ url: `${PUBLIC}/formular` }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to audit the page the browser is on: requesting private/internal network addresses is not allowed. The browser was sent to about:blank.");
    expect(calls(callTool)).toEqual([`navigate ${PUBLIC}/formular`, "navigate about:blank"]);
  });

  it("browser_axe_audit refuses to report on the private page the browser was on", async () => {
    const callTool = browser({ browser_evaluate: axeResult("http://10.0.0.5/admin") });

    const r = await (await tool("browser_axe_audit")).execute({}, ctx);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toContain("#deploy-key-field");
    expect(calls(callTool)).toEqual(["browser_evaluate", "navigate about:blank"]);
  });

  it("browser_axe_audit still reports on a public page", async () => {
    const callTool = browser({ browser_evaluate: axeResult(`${PUBLIC}/formular`) });

    const r = await (await tool("browser_axe_audit")).execute({}, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain(`URL: ${PUBLIC}/formular`);
    expect(r.output).toContain("#deploy-key-field");
    expect(calls(callTool)).toEqual(["browser_evaluate"]);
  });
});
