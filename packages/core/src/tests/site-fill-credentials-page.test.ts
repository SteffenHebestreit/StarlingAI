import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";

const mcpConnections = new Map<string, unknown>();
vi.mock("../mcp/registry.js", () => ({
  getMcpConnections: () => mcpConnections,
}));

/**
 * site_fill_credentials typed the stored username and password into whatever page the browser
 * was on. A redirect, a page's own script or a look-alike link could have put a foreign site
 * there, and the credential went into its form. The page is now read in the call itself and has
 * to be the credential's own host or a subdomain of it, over https unless the credential's login
 * URL is http.
 */
describe("site_fill_credentials types only into a page of the credential's own site", () => {
  const ctx: ToolContext = { sessionId: "session-fill-credentials", workspacePath: "/workspace" };
  const tempDir = mkdtempSync(join(tmpdir(), "sai-fill-credentials-"));
  let getTool: typeof import("../tools/registry.js").getTool;

  beforeAll(async () => {
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      sites: {
        "example.com": { username: "agent@example.com", password: "pw-for-example", loginUrl: "https://example.com/login" },
        "intranet.example": { username: "agent", password: "pw-for-intranet", loginUrl: "http://intranet.example/login" },
        "nourl.example": { username: "agent", password: "pw-for-nourl" },
        "app.example.com": {
          username: "agent@example.com",
          password: "pw-for-app",
          loginUrl: "https://login.sso-provider.test/oauth/authorize?client_id=app",
          urls: { reports: "http://reports.lan.example/monthly" },
        },
        "192.168.10.20": { username: "admin", password: "pw-for-router", loginUrl: "http://192.168.10.20/login" },
        "shop.example": { username: "agent", password: "pw-for-shop", loginUrl: "https://www.shop-login.example/signin" },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    ({ getTool } = await import("../tools/registry.js"));
    await import("../tools/credentials.js");
    await import("../tools/multimodal.js");
  });

  afterEach(() => {
    mcpConnections.clear();
  });

  afterAll(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A Playwright MCP snapshot of a login form, on the page at `url` (no Page URL line when null). */
  const loginForm = (url: string | null) => [
    "### Page",
    ...(url === null ? [] : [`- Page URL: ${url}`]),
    "- Page Title: Anmelden",
    "### Snapshot",
    "```yaml",
    "- textbox \"E-Mail\" [ref=e1]",
    "- textbox \"Passwort\" [ref=e2]",
    "- button \"Anmelden\" [ref=e3]",
    "```",
  ].join("\n");

  /** The shared browser, showing the login form at `url`; `page.url` can be changed between calls. */
  function browserOn(url: string | null) {
    const page = { url };
    const callTool = vi.fn(async (input: { name: string; arguments: Record<string, unknown> }) => ({
      content: [{ type: "text", text: input.name === "browser_snapshot" ? loginForm(page.url) : "done" }],
      isError: false,
    }));
    mcpConnections.set("playwright", { client: { callTool } });
    return { callTool, page };
  }

  /** The calls that typed into or submitted the page. */
  const typed = (callTool: ReturnType<typeof browserOn>["callTool"]) => callTool.mock.calls
    .map(([input]) => input)
    .filter((input) => input.name === "browser_type" || input.name === "browser_click");

  const fill = async (hostname: string) => getTool("site_fill_credentials")!.execute({ hostname }, ctx);

  it("fills on the credential's own host", async () => {
    const { callTool } = browserOn("https://example.com/login");

    const r = await fill("example.com");
    expect(r.success).toBe(true);
    expect(typed(callTool).map((input) => input.name)).toEqual(["browser_type", "browser_type", "browser_click"]);
    expect(typed(callTool)[1]!.arguments["text"]).toBe("pw-for-example");
  });

  it("fills on a subdomain of it", async () => {
    const { callTool } = browserOn("https://login.example.com/sso?next=%2F");

    const r = await fill("example.com");
    expect(r.success).toBe(true);
    expect(typed(callTool)).toHaveLength(3);
  });

  it.each([
    ["a look-alike that only ends in the same letters", "https://evil-example.com/login", "evil-example.com"],
    ["a host that only starts with the credential's", "https://example.com.attacker.test/login", "example.com.attacker.test"],
    ["another host", "https://attacker.test/login", "attacker.test"],
    ["an IDN look-alike (Cyrillic а)", "https://exаmple.com/login", "xn--exmple-4nf.com"],
  ])("refuses %s, typing nothing, and names both hosts", async (_label, url, pageHost) => {
    const { callTool } = browserOn(url);

    const r = await fill("example.com");
    expect(r.success).toBe(false);
    expect(r.error).toBe(`Refusing to fill the credential for example.com: the browser is on ${pageHost}, which is neither example.com nor a subdomain of it. Nothing was typed.`);
    expect(typed(callTool)).toEqual([]);
  });

  it("refuses an http page for an https credential", async () => {
    const { callTool } = browserOn("http://example.com/login");

    const r = await fill("example.com");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to fill the credential for example.com into a plain http page on example.com: only a host the credential records an http URL for takes it over http. Nothing was typed.");
    expect(typed(callTool)).toEqual([]);
  });

  it("still fills a credential whose login URL is http on its http page", async () => {
    const { callTool } = browserOn("http://intranet.example/login");

    const r = await fill("intranet.example");
    expect(r.success).toBe(true);
    expect(typed(callTool)).toHaveLength(3);
  });

  it("treats a credential that records no URL as an https one", async () => {
    const http = browserOn("http://nourl.example/login");
    expect((await fill("nourl.example")).success).toBe(false);
    expect(typed(http.callTool)).toEqual([]);

    const https = browserOn("https://nourl.example/login");
    expect((await fill("nourl.example")).success).toBe(true);
    expect(typed(https.callTool)).toHaveLength(3);
  });

  it("reads the page in the call itself: a page that moved on since the last check is refused", async () => {
    const { callTool, page } = browserOn("https://login.example.com/");
    // The agent's last look at the browser saw the credential's own login page, and the guard cleared it.
    const look = await getTool("browser_snapshot")!.execute({}, ctx);
    expect(look.success).toBe(true);
    expect(look.output).toContain("- Page URL: https://login.example.com/");

    page.url = "https://attacker.test/login";
    const r = await fill("example.com");
    expect(r.success).toBe(false);
    expect(r.error).toContain("the browser is on attacker.test, which is neither example.com nor a subdomain of it");
    expect(typed(callTool)).toEqual([]);
  });

  it("refuses when the page's URL cannot be read", async () => {
    const { callTool } = browserOn(null);

    const r = await fill("example.com");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to fill the credential for example.com: the browser's current page could not be read, so its host is unknown. Take a browser_snapshot and try again. Nothing was typed.");
    expect(typed(callTool)).toEqual([]);
  });

  // The operator records the URLs of a credential (no model-facing tool writes credentials), and
  // a login page on another domain, such as a single sign-on provider's, is one of them. Those
  // URLs' hosts are the credential's sites too; anything not recorded stays refused.
  it("fills on the host of the login URL recorded for the credential (an SSO provider)", async () => {
    const { callTool } = browserOn("https://login.sso-provider.test/oauth/authorize?client_id=app");

    const r = await fill("app.example.com");
    expect(r.success).toBe(true);
    expect(typed(callTool)[1]!.arguments["text"]).toBe("pw-for-app");
  });

  it.each([
    ["a host that only starts with the recorded one", "https://login.sso-provider.test.evil.test/oauth/authorize", "login.sso-provider.test.evil.test"],
    ["the recorded host's parent domain", "https://sso-provider.test/login", "sso-provider.test"],
    ["another host", "https://attacker.test/login", "attacker.test"],
  ])("refuses %s, typing nothing", async (_label, url, pageHost) => {
    const { callTool } = browserOn(url);

    const r = await fill("app.example.com");
    expect(r.success).toBe(false);
    expect(r.error).toBe(`Refusing to fill the credential for app.example.com: the browser is on ${pageHost}, which is not app.example.com, login.sso-provider.test or reports.lan.example, nor a subdomain of one. Nothing was typed.`);
    expect(typed(callTool)).toEqual([]);
  });

  it("refuses the recorded login host over http when the recorded URL is https", async () => {
    const { callTool } = browserOn("http://login.sso-provider.test/oauth/authorize?client_id=app");

    const r = await fill("app.example.com");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to fill the credential for app.example.com into a plain http page on login.sso-provider.test: only a host the credential records an http URL for takes it over http. Nothing was typed.");
    expect(typed(callTool)).toEqual([]);
  });

  it("lets an http recorded URL permit http on its own host only", async () => {
    const reports = browserOn("http://reports.lan.example/monthly");
    expect((await fill("app.example.com")).success).toBe(true);
    expect(typed(reports.callTool)).toHaveLength(3);

    for (const url of ["http://app.example.com/login", "http://eu.reports.lan.example/monthly"]) {
      const other = browserOn(url);
      expect((await fill("app.example.com")).success, url).toBe(false);
      expect(typed(other.callTool), url).toEqual([]);
    }
  });

  it("fills a credential for an IP address on that address only", async () => {
    const router = browserOn("http://192.168.10.20/login");
    expect((await fill("192.168.10.20")).success).toBe(true);
    expect(typed(router.callTool)).toHaveLength(3);

    // No host can end in ".192.168.10.20": URL parsing reads a numeric last label as an IPv4
    // address, so such a page URL cannot be read, and the fill is refused for that.
    for (const url of ["http://192.168.10.21/login", "http://10.192.168.10.20/login"]) {
      const other = browserOn(url);
      expect((await fill("192.168.10.20")).success, url).toBe(false);
      expect(typed(other.callTool), url).toEqual([]);
    }
  });

  it("matches a URL recorded with www. on the bare host and its subdomains", async () => {
    for (const url of ["https://shop-login.example/signin", "https://www.shop-login.example/signin", "https://eu.shop-login.example/signin"]) {
      const page = browserOn(url);
      expect((await fill("shop.example")).success, url).toBe(true);
      expect(typed(page.callTool), url).toHaveLength(3);
    }

    const lookalike = browserOn("https://evil-shop-login.example/signin");
    expect((await fill("shop.example")).success).toBe(false);
    expect(typed(lookalike.callTool)).toEqual([]);
  });
});
