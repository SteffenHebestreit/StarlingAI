import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One fake Playwright MCP server and one other MCP server, both answering from `answers` (text,
// or content parts).
const { answers, callTool } = vi.hoisted(() => {
  const answers: Record<string, string | Array<Record<string, string>>> = {};
  const callTool = vi.fn(async (input: { name: string; arguments: Record<string, unknown> }) => {
    const answer = answers[input.name] ?? "";
    return { content: typeof answer === "string" ? [{ type: "text", text: answer }] : answer };
  });
  return { answers, callTool };
});

vi.mock("../mcp/client.js", () => ({
  connectMcpServer: vi.fn(async (serverName: string) => ({
    serverName,
    client: { callTool },
    tools: (serverName === "playwright" ? ["browser_navigate", "browser_snapshot", "browser_screenshot", "browser_evaluate"] : ["read_page"])
      .map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })),
    disconnect: vi.fn(async () => {}),
  })),
  cleanupConfiguredDockerMcpContainers: vi.fn(async () => {}),
}));

/**
 * The playwright server's tools are also bridged as mcp__playwright__*, which an ephemeral agent
 * may be granted. That path called the server directly, with no guard on the URL and none on the
 * page the answer reports: a navigation to http://10.0.0.5/ ran as asked, and a page that moved on
 * there came back in the answer.
 */
describe("bridged Playwright MCP tools pass the same SSRF checks as the gateway's browser tools", () => {
  // An IP literal: the SSRF guard needs no DNS for it.
  const PUBLIC = "http://93.184.215.14";
  const INTERNAL = "Jenkins credentials: deploy-key-prod";
  const ctx = { sessionId: "session-mcp-browser-bridge", workspacePath: "/workspace" };
  const tempDir = mkdtempSync(join(tmpdir(), "sai-mcp-browser-bridge-"));
  let getTool: typeof import("../tools/registry.js").getTool;
  let shutdown: () => Promise<void>;

  beforeAll(async () => {
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      mcp: {
        servers: {
          playwright: { transport: "stdio", command: "echo", args: [], autoStart: true },
          reader: { transport: "stdio", command: "echo", args: [], autoStart: true },
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const registry = await import("../mcp/registry.js");
    ({ getTool } = await import("../tools/registry.js"));
    shutdown = registry.shutdownMcpServers;
    await registry.syncMcpServers();
  });

  afterEach(() => {
    callTool.mockClear();
    for (const key of Object.keys(answers)) delete answers[key];
  });

  afterAll(async () => {
    await shutdown();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  const calls = () => callTool.mock.calls.map(([input]) =>
    input.name === "browser_navigate" ? `navigate ${String(input.arguments["url"])}` : input.name);

  /** A Playwright MCP answer for a page at `url` showing `text`. */
  const page = (url: string, text = INTERNAL) =>
    `### Page\n- Page URL: ${url}\n- Page Title: Seite\n### Snapshot\n\`\`\`yaml\n- text: ${text}\n\`\`\``;

  it("refuses a bridged navigation to a private address before it is sent", async () => {
    const r = await getTool("mcp__playwright__browser_navigate")!.execute({ url: "http://10.0.0.5/admin" }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to navigate the browser: requesting private/internal network addresses is not allowed.");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("refuses a bridged answer that reports a private page, and sends the tab to about:blank", async () => {
    answers["browser_navigate"] = page("http://10.0.0.5/admin");

    const r = await getTool("mcp__playwright__browser_navigate")!.execute({ url: `${PUBLIC}/weiter` }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to show the page the browser is on: requesting private/internal network addresses is not allowed. The browser was sent to about:blank.");
    expect(JSON.stringify(r)).not.toContain(INTERNAL);
    expect(calls()).toEqual([`navigate ${PUBLIC}/weiter`, "navigate about:blank"]);
  });

  it("leaves a bridged answer on a public page exactly as it was", async () => {
    const answer = page(`${PUBLIC}/katalog`, "Katalog: 18 Artikel in sechs Kategorien");
    answers["browser_snapshot"] = answer;

    const r = await getTool("mcp__playwright__browser_snapshot")!.execute({}, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toBe(answer);
    expect(calls()).toEqual(["browser_snapshot"]);
  });

  it("leaves another MCP server's answers alone, whatever they contain", async () => {
    const answer = `Notes copied from a page:\n- Page URL: http://10.0.0.5/admin\n${INTERNAL}`;
    answers["read_page"] = answer;

    const r = await getTool("mcp__reader__read_page")!.execute({}, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toBe(answer);
    expect(calls()).toEqual(["read_page"]);
  });

  // A screenshot answer reports no Page URL unless the tab's header changed, so nothing was
  // checked and the image of the page the tab had drifted to went out.
  const IMAGE = "aW50ZXJuYWwgZGFzaGJvYXJk";
  const screenshot: Array<Record<string, string>> = [
    { type: "text", text: "### Result\nTook the viewport screenshot and saved it as page.png" },
    { type: "image", data: IMAGE, mimeType: "image/png" },
  ];

  it("reads the tab's address for a bridged screenshot that reports none, and refuses a private one", async () => {
    answers["browser_screenshot"] = screenshot;
    answers["browser_evaluate"] = `### Result\n${JSON.stringify("http://169.254.169.254/latest/meta-data/")}`;

    const r = await getTool("mcp__playwright__browser_screenshot")!.execute({}, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to show the page the browser is on: requesting private/internal network addresses is not allowed. The browser was sent to about:blank.");
    expect(JSON.stringify(r)).not.toContain(IMAGE);
    expect(calls()).toEqual(["browser_screenshot", "browser_evaluate", "navigate about:blank"]);
  });

  it("returns a bridged screenshot of a public tab as it was", async () => {
    answers["browser_screenshot"] = screenshot;
    answers["browser_evaluate"] = `### Result\n${JSON.stringify(`${PUBLIC}/galerie`)}`;

    const r = await getTool("mcp__playwright__browser_screenshot")!.execute({}, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain(IMAGE);
    expect(calls()).toEqual(["browser_screenshot", "browser_evaluate"]);
  });
});
